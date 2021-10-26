use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, TokenAccount, Transfer};
declare_id!("ZnnGciQUP9Qhhsqc7odCvUEXd6np2Cu87wrY6Va1u7p");

#[program]
pub mod assembly {
    use super::*;
    pub fn initialize_distributor(
        ctx: Context<InitializeDistributor>,
        dist_end_ts: i64,
        redeem_start_ts: i64,
        bumps: DerivedBumps,
    ) -> ProgramResult {
        let distributor = &mut ctx.accounts.distributor_account;

        // save instruction params
        distributor.dist_mint = *ctx.accounts.dist_mint.to_account_info().key;
        distributor.dist_end_ts = dist_end_ts;
        distributor.redeem_start_ts = redeem_start_ts;
        distributor.bumps = bumps;

        Ok(())
    }

    pub fn initialize_grant(ctx: Context<InitializeGrant>, _bump: u8) -> ProgramResult {
        if ctx.accounts.distributor_account.dist_end_ts < ctx.accounts.clock.unix_timestamp {
            return Err(ErrorCode::DistributionPeriodEnded.into());
        }

        Ok(())
    }

    pub fn transfer_grant(ctx: Context<TransferGrant>, amount: u64, _bump: u8) -> ProgramResult {
        if ctx.accounts.distributor_account.dist_end_ts < ctx.accounts.clock.unix_timestamp {
            return Err(ErrorCode::DistributionPeriodEnded.into());
        }

        // Burn the distributable tokens
        let cpi_accounts = Burn {
            mint: ctx.accounts.dist_mint.to_account_info(),
            to: ctx.accounts.dist_token.to_account_info(),
            authority: ctx.accounts.donor_authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.clone();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::burn(cpi_ctx, amount)?;

        // Mint the grant tokens
        let cpi_accounts = MintTo {
            mint: ctx.accounts.grant_mint.to_account_info(),
            to: ctx.accounts.grant_account.to_account_info(),
            authority: ctx.accounts.distributor_account.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::mint_to(
            CpiContext::new_with_signer(
                cpi_program,
                cpi_accounts,
                &[&[
                    ctx.accounts.distributor_account.dist_mint.key().as_ref(),
                    &[ctx.accounts.distributor_account.bumps.distributor_bump],
                ]],
            ),
            amount,
        )?;

        Ok(())
    }

    pub fn redeem_grant(ctx: Context<RedeemGrant>, _bump: u8) -> ProgramResult {
        if ctx.accounts.distributor_account.redeem_start_ts > ctx.accounts.clock.unix_timestamp {
            return Err(ErrorCode::RedeemPeriodNotStarted.into());
        }

        let grant = ctx.accounts.grant_account.amount;

        // Burn the grant tokens
        let cpi_accounts = Burn {
            mint: ctx.accounts.grant_mint.to_account_info(),
            to: ctx.accounts.grant_account.to_account_info(),
            authority: ctx.accounts.distributor_account.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.clone();
        token::burn(
            CpiContext::new_with_signer(
                cpi_program,
                cpi_accounts,
                &[&[
                    ctx.accounts.distributor_account.dist_mint.key().as_ref(),
                    &[ctx.accounts.distributor_account.bumps.distributor_bump],
                ]],
            ),
            grant,
        )?;

        // Transfer the reward
        let cpi_accounts = Transfer {
            from: ctx.accounts.reward_vault.to_account_info(),
            to: ctx.accounts.receiver_token_account.to_account_info(),
            authority: ctx.accounts.distributor_account.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(
            CpiContext::new_with_signer(
                cpi_program,
                cpi_accounts,
                &[&[
                    ctx.accounts.distributor_account.dist_mint.key().as_ref(),
                    &[ctx.accounts.distributor_account.bumps.distributor_bump],
                ]],
            ),
            grant,
        )?;

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(dist_end_ts: i64, redeem_start_ts: i64, bumps: DerivedBumps)]
pub struct InitializeDistributor<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub freeze_authority: Signer<'info>,

    #[account(
        constraint = dist_mint.decimals == reward_mint.decimals,
        constraint = dist_mint.freeze_authority.unwrap()  == freeze_authority.key())]
    pub dist_mint: Box<Account<'info, Mint>>,

    pub reward_mint: Box<Account<'info, Mint>>,

    #[account(init,
        seeds = [dist_mint.key().as_ref()],
        bump = bumps.distributor_bump,
        payer = payer)]
    pub distributor_account: Box<Account<'info, DistributorAccount>>,

    #[account(init,
        mint::decimals = dist_mint.decimals,
        mint::authority = distributor_account,
        mint::freeze_authority = freeze_authority,
        seeds = [distributor_account.key().as_ref(), b"grant_mint".as_ref()],
        bump = bumps.grant_bump,
        payer = payer)]
    pub grant_mint: Box<Account<'info, Mint>>,

    #[account(init,
        token::mint = reward_mint,
        token::authority = distributor_account,
        seeds = [distributor_account.key().as_ref(), b"reward_vault".as_ref(), reward_mint.key().as_ref()],
        bump = bumps.reward_bump,
        payer = payer)]
    pub reward_vault: Box<Account<'info, TokenAccount>>,

    pub rent: Sysvar<'info, Rent>,

    pub system_program: Program<'info, System>,

    #[account(constraint = token_program.key == &token::ID)]
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(bump: u8)]
pub struct InitializeGrant<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub donor_authority: Signer<'info>,

    pub receiver_authority: AccountInfo<'info>,

    #[account(
        seeds = [distributor_account.dist_mint.key().as_ref()],
        bump = distributor_account.bumps.distributor_bump,
    )]
    pub distributor_account: Box<Account<'info, DistributorAccount>>,

    #[account(
        seeds = [distributor_account.key().as_ref(), b"grant_mint".as_ref()],
        bump = distributor_account.bumps.grant_bump)]
    pub grant_mint: Box<Account<'info, Mint>>,

    #[account(init,
        token::mint = grant_mint,
        token::authority = distributor_account,
        seeds = [distributor_account.key().as_ref(), b"grant".as_ref(), receiver_authority.key().as_ref()],
        bump = bump,
        payer = payer)]
    pub grant_account: Box<Account<'info, TokenAccount>>,

    pub clock: Sysvar<'info, Clock>,

    pub rent: Sysvar<'info, Rent>,

    pub system_program: Program<'info, System>,

    #[account(constraint = token_program.key == &token::ID)]
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(amount: u64, bump: u8)]
pub struct TransferGrant<'info> {
    pub payer: Signer<'info>,

    pub donor_authority: Signer<'info>,

    pub receiver_authority: AccountInfo<'info>,

    #[account(
        seeds = [distributor_account.dist_mint.key().as_ref()],
        bump = distributor_account.bumps.distributor_bump,
    )]
    pub distributor_account: Box<Account<'info, DistributorAccount>>,

    #[account(mut, constraint = dist_mint.key() == distributor_account.dist_mint)]
    pub dist_mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub dist_token: Box<Account<'info, TokenAccount>>,

    #[account(mut,
        seeds = [distributor_account.key().as_ref(), b"grant_mint".as_ref()],
        bump = distributor_account.bumps.grant_bump)]
    pub grant_mint: Box<Account<'info, Mint>>,

    #[account(mut,
        seeds = [distributor_account.key().as_ref(), b"grant".as_ref(), receiver_authority.key().as_ref()],
        bump = bump)]
    pub grant_account: Box<Account<'info, TokenAccount>>,

    pub clock: Sysvar<'info, Clock>,

    pub rent: Sysvar<'info, Rent>,

    pub system_program: Program<'info, System>,

    #[account(constraint = token_program.key == &token::ID)]
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(bump: u8)]
pub struct RedeemGrant<'info> {
    pub payer: Signer<'info>,

    pub receiver_authority: Signer<'info>,

    #[account(
        seeds = [distributor_account.dist_mint.key().as_ref()],
        bump = distributor_account.bumps.distributor_bump,
    )]
    pub distributor_account: Box<Account<'info, DistributorAccount>>,

    #[account(mut,
        seeds = [distributor_account.key().as_ref(), b"grant_mint".as_ref()],
        bump = distributor_account.bumps.grant_bump)]
    pub grant_mint: Box<Account<'info, Mint>>,

    #[account(mut,
        seeds = [distributor_account.key().as_ref(), b"grant".as_ref(), receiver_authority.key().as_ref()],
        bump = bump)]
    pub grant_account: Box<Account<'info, TokenAccount>>,

    pub reward_mint: Box<Account<'info, Mint>>,

    #[account(mut,
        seeds = [distributor_account.key().as_ref(), b"reward_vault".as_ref(), reward_mint.key().as_ref()],
        bump = distributor_account.bumps.reward_bump)]
    pub reward_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, constraint = receiver_token_account.owner == receiver_authority.key())]
    pub receiver_token_account: Box<Account<'info, TokenAccount>>,

    pub clock: Sysvar<'info, Clock>,

    #[account(constraint = token_program.key == &token::ID)]
    pub token_program: AccountInfo<'info>,
}

#[account]
#[derive(Default)]
pub struct DistributorAccount {
    pub dist_mint: Pubkey,
    pub dist_end_ts: i64,
    pub redeem_start_ts: i64,
    pub bumps: DerivedBumps,
}

#[derive(AnchorSerialize, AnchorDeserialize, Default, Clone)]
pub struct DerivedBumps {
    pub distributor_bump: u8,
    pub grant_bump: u8,
    pub reward_bump: u8,
}

#[error]
pub enum ErrorCode {
    #[msg("Distribution period ended")]
    DistributionPeriodEnded,
    #[msg("Redeem period has not started")]
    RedeemPeriodNotStarted,
}
