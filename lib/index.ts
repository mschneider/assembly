import * as anchor from "@project-serum/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { associatedTokenAccount, mint } from "easy-spl";
import * as bs58 from "bs58";
import { chunk } from "./chunk";
import { publicKey } from "@project-serum/anchor/dist/cjs/utils";

const MEMO_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export async function prepareDistMint(
  provider: anchor.Provider,
  rewardMint: PublicKey,
  distributors: { authority: PublicKey }[],
  governingAuthority?: PublicKey
): Promise<PublicKey> {
  if (!governingAuthority) {
    governingAuthority = provider.wallet.publicKey;
  }
  const feePayer = provider.wallet.publicKey;
  const recentBlockhash = (await provider.connection.getRecentBlockhash())
    .blockhash;
  const rewardMintInfo = await mint.get.info(provider.connection, rewardMint);

  // create mint account
  const distMint = Keypair.generate();

  const mintTx = await mint.create.tx(
    provider.connection,
    rewardMintInfo.decimals,
    distMint.publicKey,
    governingAuthority,
    provider.wallet.publicKey
  );
  mintTx.partialSign(distMint);

  // create all associated token accounts for the distributors
  const createTokenIxs = await Promise.all(
    distributors.map(async (d) =>
      associatedTokenAccount.create.maybeInstructions(
        provider.connection,
        distMint.publicKey,
        d.authority,
        provider.wallet.publicKey
      )
    )
  );

  // batch token accounts into multiple txs to not run into tx size limit
  const createTokenIxsPerTx = chunk(
    createTokenIxs.filter((ixs) => ixs.length > 0),
    5
  );
  const createTokenTxs = createTokenIxsPerTx.map((ixsChunk) =>
    new Transaction({ feePayer, recentBlockhash }).add(...ixsChunk.flat(1))
  );

  const txs = await provider.wallet.signAllTransactions(
    [mintTx].concat(createTokenTxs)
  );

  const sigs = await provider.sendAll(txs.map((tx) => ({ tx, signers: [] })));

  console.log("prepareDistMint", distMint.publicKey.toString(), ...sigs);

  return distMint.publicKey;
}

export async function mintBudgetInstructions(
  provider: anchor.Provider,
  distMint: PublicKey,
  rewardMint: PublicKey,
  distributors: { authority: PublicKey; amount: number }[],
  governingAuthority?: PublicKey
): Promise<TransactionInstruction[]> {
  if (!governingAuthority) {
    governingAuthority = provider.wallet.publicKey;
  }

  const rewardMintInfo = await mint.get.info(provider.connection, rewardMint);

  const ixs = await Promise.all(
    distributors.map(async (d) => {
      const tokenAccount =
        await associatedTokenAccount.getAssociatedTokenAddress(
          distMint,
          d.authority
        );
      return mint.mintTo.rawInstructions(
        distMint,
        tokenAccount,
        governingAuthority,
        d.amount * Math.pow(10, rewardMintInfo.decimals)
      );
    })
  );

  return ixs.flat(1);
}

export async function mintBudget(
  provider: anchor.Provider,
  distMint: PublicKey,
  rewardMint: PublicKey,
  distributors: { authority: PublicKey; amount: number }[]
) {
  const ixs = await mintBudgetInstructions(
    provider,
    distMint,
    rewardMint,
    distributors
  );

  return await provider.send(new Transaction().add(...ixs));
}

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

  console.log(
    "initializeDistributor",
    freezeAuthority.toString(),
    distMint.toString(),
    rewardMint.toString(),
    distributorAccount.toString(),
    grantMint.toString(),
    rewardVault.toString()
  );
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
  const tx = new Transaction();

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
  let tx = new Transaction();

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
