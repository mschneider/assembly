import * as anchor from "@project-serum/anchor";
import * as spl from "@solana/spl-token";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";

import chai from "chai";
import chaiAsPromised from "chai-as-promised";
chai.use(chaiAsPromised);
const expect = chai.expect;

import {
  assignGrant,
  createDistributor,
  deriveDistributorAccounts,
  deriveGrantAccount,
  getGrants,
  redeemGrant,
} from "../lib";

import { sleep } from "../lib/sleep";

async function createMint(provider, authority?, decimals = 6) {
  if (authority === undefined) {
    authority = provider.wallet.publicKey;
  }
  const mint = await spl.Token.createMint(
    provider.connection,
    provider.wallet.payer,
    authority, // mint
    authority, // freeze
    decimals,
    spl.TOKEN_PROGRAM_ID
  );
  return mint;
}

async function createTokenAccount(provider, mint, owner) {
  const token = new spl.Token(
    provider.connection,
    mint,
    spl.TOKEN_PROGRAM_ID,
    provider.wallet.payer
  );
  let vault = await token.createAssociatedTokenAccount(owner);
  return vault;
}

async function transferToken(provider, mint, source, destination, amount) {
  const token = new spl.Token(
    provider.connection,
    mint,
    spl.TOKEN_PROGRAM_ID,
    provider.wallet.payer
  );

  const tx = await token.transfer(
    source,
    destination,
    provider.wallet.payer,
    [],
    amount
  );

  return tx;
}

async function getMintAccount(provider, pubkey) {
  const token = new spl.Token(
    provider.connection,
    pubkey,
    spl.TOKEN_PROGRAM_ID,
    provider.wallet.payer
  );

  const account = await token.getMintInfo();

  return account;
}

async function getTokenAccount(provider, mint, pubkey) {
  const token = new spl.Token(
    provider.connection,
    mint,
    spl.TOKEN_PROGRAM_ID,
    provider.wallet.payer
  );

  const account = await token.getAccountInfo(pubkey);

  return account;
}

async function getAssociatedTokenAccount(provider, mint, owner) {
  const token = new spl.Token(
    provider.connection,
    mint,
    spl.TOKEN_PROGRAM_ID,
    provider.wallet.payer
  );

  let vault = await token.getOrCreateAssociatedAccountInfo(owner);
  return vault;
}

async function freezeTokenAccount(provider, mint, address) {
  const token = new spl.Token(
    provider.connection,
    mint,
    spl.TOKEN_PROGRAM_ID,
    provider.wallet.payer
  );

  await token.freezeAccount(address, provider.wallet.payer, []);
}

async function generateTestUserAccount(provider, mint) {
  const keypair = anchor.web3.Keypair.generate();
  const associatedTokenAccount = await spl.Token.getAssociatedTokenAddress(
    spl.ASSOCIATED_TOKEN_PROGRAM_ID,
    spl.TOKEN_PROGRAM_ID,
    mint,
    keypair.publicKey
  );
  return { keypair, associatedTokenAccount };
}

describe("assembly", () => {
  const provider = anchor.Provider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Assembly;

  const perUserDistAmount = 100;
  const totalRewardAmount = 100_000;
  const userA = anchor.web3.Keypair.generate();
  const userB = anchor.web3.Keypair.generate();
  let distMint, distTokenA, distTokenB;
  let rewardMint, rewardToken;
  let distEndTs, redeemStartTs;

  beforeEach(async () => {
    distMint = await createMint(provider);
    distTokenA = await createTokenAccount(
      provider,
      distMint.publicKey,
      userA.publicKey
    );
    distTokenB = await createTokenAccount(
      provider,
      distMint.publicKey,
      userB.publicKey
    );
    await distMint.mintTo(
      distTokenA,
      provider.wallet.publicKey,
      [],
      perUserDistAmount
    );
    await distMint.mintTo(
      distTokenB,
      provider.wallet.publicKey,
      [],
      perUserDistAmount
    );

    // prepare reward tokens
    rewardMint = await createMint(provider);
    rewardToken = await createTokenAccount(
      provider,
      rewardMint.publicKey,
      provider.wallet.publicKey
    );
    await rewardMint.mintTo(
      rewardToken,
      provider.wallet.publicKey,
      [],
      totalRewardAmount
    );

    // choose timestamps
    distEndTs = new anchor.BN(Date.now() / 1000 + 2);
    redeemStartTs = new anchor.BN(Date.now() / 1000 + 3);
  });

  it("can initialize a whole budget", async () => {
    const program = anchor.workspace.Assembly;

    const temporaryPdaSeed = anchor.web3.Keypair.generate().publicKey;
    const [temporaryPda, temporaryPdaBump] = await PublicKey.findProgramAddress(
      [temporaryPdaSeed.toBuffer()],
      program.programId
    );

    const [distMintAccount, distMintBump] = await PublicKey.findProgramAddress(
      [temporaryPda.toBuffer(), Buffer.from("dist_mint")],
      program.programId
    );

    console.log("temporary_pda", temporaryPda.toString());
    console.log("dist_mint", distMintAccount.toString());
    console.log("reward_mint", rewardMint.publicKey.toString());

    // attach all user accounts that should receive a budget
    const users = await Promise.all(
      [...Array(4)].map((_) =>
        generateTestUserAccount(provider, distMintAccount)
      )
    );
    const remainingAccounts = users.flatMap((u) => [
      { pubkey: u.associatedTokenAccount, isWritable: true, isSigner: false },
      { pubkey: u.keypair.publicKey, isWritable: false, isSigner: false },
    ]);
    console.log("remainingAccounts", remainingAccounts);

    const tx = await program.rpc.initializeBudget(
      {
        temporaryPdaBump,
        distMintBump,
        allocations: users.map((_, i) => new anchor.BN(i * 1_000_000)),
      },
      {
        accounts: {
          payer: provider.wallet.publicKey,
          freezeAuthority: provider.wallet.publicKey,
          distMint: distMintAccount,
          rewardMint: rewardMint.publicKey,
          temporaryPda,
          temporaryPdaSeed,
          rent: SYSVAR_RENT_PUBKEY,
          systemProgram: SystemProgram.programId,
          tokenProgram: spl.TOKEN_PROGRAM_ID,
          associatedTokenProgram: spl.ASSOCIATED_TOKEN_PROGRAM_ID,
        },
        remainingAccounts,
      }
    );
    console.debug("initializeBudget", temporaryPda.toString(), tx);
  });

  /*

  it("can initialize_distributor with an already distributed mint", async () => {
    const distributorAccount = await createDistributor(
      provider,
      distMint.publicKey,
      rewardMint.publicKey,
      provider.wallet.publicKey,
      distEndTs,
      redeemStartTs
    );

    const { grantMint, rewardVault, distributorBump, grantBump, rewardBump } =
      await deriveDistributorAccounts(distMint.publicKey, rewardMint.publicKey);

    console.log("derive", grantMint.toString(), rewardVault.toString());

    const distributor = await program.account.distributorAccount.fetch(
      distributorAccount
    );
    expect(distributor.distMint).to.eql(distMint.publicKey);
    expect(distributor.args).to.eql({
      distEndTs,
      redeemStartTs,
      distributorBump,
      grantBump,
      rewardBump,
    });

    const grantMintState = await getMintAccount(provider, grantMint);
    expect(grantMintState.isInitialized).to.eql(true);
    expect(grantMintState.mintAuthority).to.eql(distributorAccount);
    // expect(grantMintState.freezeAuthority).to.eql(new anchor.web3.PublicKey(''))

    const tx2 = await transferToken(
      provider,
      rewardMint.publicKey,
      rewardToken,
      rewardVault,
      totalRewardAmount
    );
    console.log("transferToken", tx2);

    const rewardVaultState = await getTokenAccount(
      provider,
      rewardMint.publicKey,
      rewardVault
    );
    expect(rewardVaultState.isInitialized).to.eql(true);
    expect(rewardVaultState.owner).to.eql(distributorAccount);
    expect(rewardVaultState.amount.toNumber()).to.eql(totalRewardAmount);

    expect(
      createDistributor(
        provider,
        distMint.publicKey,
        rewardMint.publicKey,
        provider.wallet.publicKey,
        distEndTs,
        distEndTs
      )
    ).to.be.rejected;
  });

  it("can grant distribute rewards to contributors", async () => {
    const distributorAccount = await createDistributor(
      provider,
      distMint.publicKey,
      rewardMint.publicKey,
      provider.wallet.publicKey,
      distEndTs,
      redeemStartTs
    );

    const { rewardVault } = await deriveDistributorAccounts(
      distMint.publicKey,
      rewardMint.publicKey
    );

    const tx1_ = await transferToken(
      provider,
      rewardMint.publicKey,
      rewardToken,
      rewardVault,
      totalRewardAmount
    );
    console.log("transferToken", tx1_);

    await assignGrant(
      provider,
      distMint.publicKey,
      rewardMint.publicKey,
      userA.publicKey,
      perUserDistAmount,
      "full grant to user a",
      userB
    );
    await assignGrant(
      provider,
      distMint.publicKey,
      rewardMint.publicKey,
      userB.publicKey,
      perUserDistAmount / 2,
      "half grant to user b",
      userA
    );

    await sleep(3000);

    const grants = await getGrants(
      provider,
      distMint.publicKey,
      rewardMint.publicKey
    );

    expect(grants[0]).to.deep.include({
      transfer: {
        from: userA.publicKey.toString(),
        to: userB.publicKey.toString(),
        amount: perUserDistAmount / 2,
      },
      memo: "half grant to user b",
    });
    expect(grants[1]).to.deep.include({
      transfer: {
        from: userB.publicKey.toString(),
        to: userA.publicKey.toString(),
        amount: perUserDistAmount,
      },
      memo: "full grant to user a",
    });

    await redeemGrant(
      provider,
      distMint.publicKey,
      rewardMint.publicKey,
      userA
    );
    await redeemGrant(
      provider,
      distMint.publicKey,
      rewardMint.publicKey,
      userB
    );

    const userRewardA = await getAssociatedTokenAccount(
      provider,
      rewardMint.publicKey,
      userA.publicKey
    );
    const userRewardB = await getAssociatedTokenAccount(
      provider,
      rewardMint.publicKey,
      userB.publicKey
    );

    expect(userRewardA.amount.toString()).to.eq(perUserDistAmount.toString());
    expect(userRewardB.amount.toString()).to.eq(
      (perUserDistAmount / 2).toString()
    );
  });

  it("can freeze grants", async () => {
    const distributorAccount = await createDistributor(
      provider,
      distMint.publicKey,
      rewardMint.publicKey,
      provider.wallet.publicKey,
      distEndTs,
      redeemStartTs
    );

    const { grantMint, rewardVault, bumps } = await deriveDistributorAccounts(
      distMint.publicKey,
      rewardMint.publicKey
    );

    const tx1_ = await transferToken(
      provider,
      rewardMint.publicKey,
      rewardToken,
      rewardVault,
      totalRewardAmount
    );
    console.log("transferToken", tx1_);

    await assignGrant(
      provider,
      distMint.publicKey,
      rewardMint.publicKey,
      userA.publicKey,
      perUserDistAmount,
      "full grant to user a",
      userB
    );

    await sleep(3000);

    const grants = await getGrants(
      provider,
      distMint.publicKey,
      rewardMint.publicKey
    );

    expect(grants[0]).to.deep.include({
      transfer: {
        from: userB.publicKey.toString(),
        to: userA.publicKey.toString(),
        amount: perUserDistAmount,
      },
      memo: "full grant to user a",
    });

    const { grantAccount } = await deriveGrantAccount(
      distributorAccount,
      userA.publicKey
    );

    await freezeTokenAccount(provider, grantMint, grantAccount);

    expect(
      redeemGrant(provider, distMint.publicKey, rewardMint.publicKey, userA)
    ).to.be.rejected;
  });
  // */
});
