import * as anchor from "@project-serum/anchor";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { associatedTokenAccount } from "easy-spl";
import * as bs58 from "bs58";

const MEMO_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

// pass public keys and receive parsed account
export async function createDistributor(
  provider: anchor.Provider,
  distMint: PublicKey,
  rewardMint: PublicKey,
  freezeAuthority: PublicKey,
  distEndTs: number,
  redeemStartTs: number
): Promise<PublicKey> {
  const program = anchor.workspace.Assembly;
  const { distributorAccount, grantMint, rewardVault, bumps } =
    await deriveDistributorAccounts(distMint, rewardMint);
  const tx = await program.rpc.initializeDistributor(
    distEndTs,
    redeemStartTs,
    bumps,
    {
      accounts: {
        payer: provider.wallet.publicKey,
        freezeAuthority,
        distMint,
        rewardMint,
        distributorAccount,
        grantMint,
        rewardVault,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
    }
  );
  console.debug("createDistributor", distributorAccount.toString(), tx);
  return distributorAccount;
}

export async function assignGrant(
  provider: anchor.Provider,
  distMint: PublicKey,
  rewardMint: PublicKey,
  receiverAuthority: PublicKey,
  amount: number,
  memo?: string,
  donor?: anchor.web3.Signer
) {
  const donorAuthority = donor ? donor.publicKey : provider.wallet.publicKey;

  const program = anchor.workspace.Assembly;
  const tx = new anchor.web3.Transaction();

  const { distributorAccount, grantMint } = await deriveDistributorAccounts(
    distMint,
    rewardMint
  );
  const { grantAccount, grantBump } = await deriveGrantAccount(
    distributorAccount,
    receiverAuthority
  );
  let grantAccountState = await provider.connection.getAccountInfo(
    grantAccount
  );
  if (grantAccountState == null) {
    console.debug(
      "initializeGrant",
      distributorAccount.toString(),
      grantAccount.toString()
    );

    tx.add(
      await program.instruction.initializeGrant(grantBump, {
        accounts: {
          payer: provider.wallet.publicKey,
          donorAuthority,
          receiverAuthority,
          distributorAccount,
          grantMint,
          grantAccount,
          clock: SYSVAR_CLOCK_PUBKEY,
          rent: SYSVAR_RENT_PUBKEY,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
      })
    );
  }

  const donorTokenAccount =
    await associatedTokenAccount.getAssociatedTokenAddress(
      distMint,
      donorAuthority
    );

  console.debug(
    "transferGrant",
    distributorAccount.toString(),
    grantAccount.toString(),
    donorTokenAccount.toString()
  );
  tx.add(
    await program.instruction.transferGrant(new anchor.BN(amount), grantBump, {
      accounts: {
        payer: provider.wallet.publicKey,
        donorAuthority,
        receiverAuthority,
        distributorAccount,
        distMint,
        distToken: donorTokenAccount,
        grantMint,
        grantAccount,
        clock: SYSVAR_CLOCK_PUBKEY,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
    })
  );

  if (memo) {
    console.debug("memo", memo);
    tx.add(
      new TransactionInstruction({
        keys: [],
        programId: MEMO_ID,
        data: Buffer.from(memo),
      })
    );
  }

  const signers = donor ? [donor] : [];
  const signature = await provider.send(tx, signers, { skipPreflight: true });
  console.log(signature);

  return grantAccount;
}

export async function getGrants(
  provider: anchor.Provider,
  distMint: PublicKey,
  rewardMint: PublicKey
) {
  const { grantMint } = await deriveDistributorAccounts(distMint, rewardMint);
  const signatures =
    await provider.connection.getConfirmedSignaturesForAddress2(
      grantMint,
      {},
      "confirmed"
    );

  const transactions = await Promise.all(
    signatures.map((s) =>
      provider.connection.getTransaction(s.signature, {
        commitment: "confirmed",
      })
    )
  );

  let result: {
    transfer: { from: string; to: string; amount: number };
    memo: string;
    signature: string;
    slot: number;
  }[] = [];
  for (var i = 0; i < signatures.length; i++) {
    const { signature, slot } = signatures[i];
    const t = transactions[i];
    let assemblyId, memoId;

    // @ts-ignore
    const entries = t.transaction.message.indexToProgramIds.entries();
    for (const [k, v] of entries) {
      if (v.equals(anchor.workspace.Assembly.programId)) {
        assemblyId = k;
      }
      if (v.equals(MEMO_ID)) {
        memoId = k;
      }
    }

    let transfer, memo: string;
    for (const instruction of t.transaction.message.instructions) {
      switch (instruction.programIdIndex) {
        case assemblyId:
          const parsedIns = anchor.workspace.Assembly.coder.instruction.decode(
            instruction.data,
            "base58"
          );
          if (parsedIns.name === "transferGrant") {
            let parsedAccounts = {};
            const idlIns = anchor.workspace.Assembly.idl.instructions.filter(
              (idlIns) => parsedIns.name === idlIns.name
            )[0];
            idlIns.accounts.forEach((acc, ix) => {
              const txIx = instruction.accounts[ix];
              const pk = t.transaction.message.accountKeys[txIx];
              parsedAccounts[acc.name] = pk.toString();
            });
            transfer = {
              from: parsedAccounts["donorAuthority"],
              to: parsedAccounts["receiverAuthority"],
              amount: parsedIns.data.amount.toNumber(),
            };
          }
          break;
        case memoId:
          memo = bs58.decode(instruction.data).toString("utf-8");

          break;
      }
    }

    if (transfer) result.push({ signature, slot, transfer, memo });
  }

  return result;
}

export async function redeemGrant(
  provider: anchor.Provider,
  distMint: PublicKey,
  rewardMint: PublicKey,
  receiver?: anchor.web3.Signer
) {
  const program = anchor.workspace.Assembly;
  let tx = new anchor.web3.Transaction();

  const receiverAuthority = receiver
    ? receiver.publicKey
    : provider.wallet.publicKey;
  const receiverTokenAccount =
    await associatedTokenAccount.getAssociatedTokenAddress(
      rewardMint,
      receiverAuthority
    );
  let receiverTokenAccountState = await provider.connection.getAccountInfo(
    receiverTokenAccount
  );
  if (receiverTokenAccountState == null) {
    tx.add(
      ...(await associatedTokenAccount.createAssociatedTokenAccountInstructions(
        rewardMint,
        receiverTokenAccount,
        receiverAuthority,
        provider.wallet.publicKey
      ))
    );
  }

  const { distributorAccount, grantMint, rewardVault } =
    await deriveDistributorAccounts(distMint, rewardMint);
  const { grantAccount, grantBump } = await deriveGrantAccount(
    distributorAccount,
    receiverAuthority
  );

  tx.add(
    await program.instruction.redeemGrant(grantBump, {
      accounts: {
        payer: provider.wallet.publicKey,
        receiverAuthority,
        distributorAccount,
        grantMint,
        grantAccount,
        rewardMint,
        rewardVault,
        receiverTokenAccount,
        clock: SYSVAR_CLOCK_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
    })
  );

  const signers = receiver ? [receiver] : [];
  const signature = await provider.send(tx, signers, { skipPreflight: true });
  return signature;
}

export async function deriveDistributorAccounts(
  distMint: PublicKey,
  rewardMint: PublicKey
) {
  const program = anchor.workspace.Assembly;
  console.log("deriveDistributorAccounts", program.programId.toString());

  const [distributorAccount, distributorBump] =
    await PublicKey.findProgramAddress(
      [distMint.toBuffer()],
      program.programId
    );

  const [grantMint, grantBump] = await PublicKey.findProgramAddress(
    [distributorAccount.toBuffer(), Buffer.from("grant_mint")],
    program.programId
  );

  const [rewardVault, rewardBump] = await PublicKey.findProgramAddress(
    [
      distributorAccount.toBuffer(),
      Buffer.from("reward_vault"),
      rewardMint.toBuffer(),
    ],
    program.programId
  );

  return {
    distributorAccount,
    grantMint,
    rewardVault,
    bumps: {
      distributorBump,
      grantBump,
      rewardBump,
    },
  };
}

export async function deriveGrantAccount(
  distributor: PublicKey,
  receiver: PublicKey
) {
  const program = anchor.workspace.Assembly;
  const [grantAccount, grantBump] = await PublicKey.findProgramAddress(
    [distributor.toBuffer(), Buffer.from("grant"), receiver.toBuffer()],
    program.programId
  );
  return {
    grantAccount,
    grantBump,
  };
}
