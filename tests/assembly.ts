import * as anchor from "@project-serum/anchor";
import * as spl from "@solana/spl-token";

import chai from "chai";
import chaiAsPromised from "chai-as-promised";
import { tokenAccount } from "easy-spl";
chai.use(chaiAsPromised);
const expect = chai.expect;

import {
  assignGrant,
  createDistributor,
  deriveDistributorAccounts,
  deriveGrantAccount,
  getGrants,
  mintBudget,
  mintBudgetInstructions,
  prepareDistMint,
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
    // prepare reward tokens
    const rewardMintInfo = await createMint(provider);
    rewardMint = rewardMintInfo.publicKey;
    rewardToken = await createTokenAccount(
      provider,
      rewardMint,
      provider.wallet.publicKey
    );
    await rewardMintInfo.mintTo(
      rewardToken,
      provider.wallet.publicKey,
      [],
      totalRewardAmount
    );

    // prepare distributor tokens
    const distributors = [
      {
        authority: userA.publicKey,
        amount: perUserDistAmount,
      },
      {
        authority: userB.publicKey,
        amount: perUserDistAmount,
      },
    ];

    distMint = await prepareDistMint(provider, rewardMint, distributors);

    const tx = await mintBudget(provider, distMint, rewardMint, distributors);

    console.log("mintBudget", tx);

    const tokenAccounts = await Promise.all(
      distributors.map(async (d) =>
        getAssociatedTokenAccount(provider, distMint, d.authority)
      )
    );
    distTokenA = tokenAccounts[0];
    distTokenB = tokenAccounts[1];

    // choose timestamps
    distEndTs = new anchor.BN(Date.now() / 1000 + 2);
    redeemStartTs = new anchor.BN(Date.now() / 1000 + 3);
  });

  it("can initialize_distributor with an already distributed mint", async () => {
    const distributorAccount = await createDistributor(
      provider,
      distMint,
      rewardMint,
      provider.wallet.publicKey,
      distEndTs,
      redeemStartTs
    );

    const { grantMint, rewardVault, bumps } = await deriveDistributorAccounts(
      distMint,
      rewardMint
    );

    console.log("derive", grantMint.toString(), rewardVault.toString(), bumps);

    const distributor = await program.account.distributorAccount.fetch(
      distributorAccount
    );
    expect(distributor.distMint).to.eql(distMint);
    expect(distributor.distEndTs).to.eql(distEndTs);
    expect(distributor.redeemStartTs).to.eql(redeemStartTs);
    expect(distributor.bumps.distributorBump).to.eql(bumps.distributorBump);
    expect(distributor.bumps.grantBump).to.eql(bumps.grantBump);
    expect(distributor.bumps.rewardBump).to.eql(bumps.rewardBump);

    const grantMintState = await getMintAccount(provider, grantMint);
    expect(grantMintState.isInitialized).to.eql(true);
    expect(grantMintState.mintAuthority).to.eql(distributorAccount);
    expect(grantMintState.freezeAuthority).to.eql(provider.wallet.publicKey);

    const tx2 = await transferToken(
      provider,
      rewardMint,
      rewardToken,
      rewardVault,
      totalRewardAmount
    );
    console.log("transferToken", tx2);

    const rewardVaultState = await getTokenAccount(
      provider,
      rewardMint,
      rewardVault
    );
    expect(rewardVaultState.isInitialized).to.eql(true);
    expect(rewardVaultState.owner).to.eql(distributorAccount);
    expect(rewardVaultState.amount.toNumber()).to.eql(totalRewardAmount);

    expect(
      createDistributor(
        provider,
        distMint,
        rewardMint,
        provider.wallet.publicKey,
        distEndTs,
        distEndTs
      )
    ).to.be.rejected;
  });

  it("can grant distribute rewards to contributors", async () => {
    const distributorAccount = await createDistributor(
      provider,
      distMint,
      rewardMint,
      provider.wallet.publicKey,
      distEndTs,
      redeemStartTs
    );

    const { rewardVault } = await deriveDistributorAccounts(
      distMint,
      rewardMint
    );

    const tx1_ = await transferToken(
      provider,
      rewardMint,
      rewardToken,
      rewardVault,
      totalRewardAmount
    );
    console.log("transferToken", tx1_);

    await assignGrant(
      provider,
      distMint,
      rewardMint,
      userA.publicKey,
      perUserDistAmount,
      "full grant to user a",
      userB
    );
    await assignGrant(
      provider,
      distMint,
      rewardMint,
      userB.publicKey,
      perUserDistAmount / 2,
      "half grant to user b",
      userA
    );

    await sleep(3000);

    const grants = await getGrants(provider, distMint, rewardMint);

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

    await redeemGrant(provider, distMint, rewardMint, userA);
    await redeemGrant(provider, distMint, rewardMint, userB);

    const userRewardA = await getAssociatedTokenAccount(
      provider,
      rewardMint,
      userA.publicKey
    );
    const userRewardB = await getAssociatedTokenAccount(
      provider,
      rewardMint,
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
      distMint,
      rewardMint,
      provider.wallet.publicKey,
      distEndTs,
      redeemStartTs
    );

    const { grantMint, rewardVault, bumps } = await deriveDistributorAccounts(
      distMint,
      rewardMint
    );

    const tx1_ = await transferToken(
      provider,
      rewardMint,
      rewardToken,
      rewardVault,
      totalRewardAmount
    );
    console.log("transferToken", tx1_);

    await assignGrant(
      provider,
      distMint,
      rewardMint,
      userA.publicKey,
      perUserDistAmount,
      "full grant to user a",
      userB
    );

    await sleep(3000);

    const grants = await getGrants(provider, distMint, rewardMint);

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

    expect(redeemGrant(provider, distMint, rewardMint, userA)).to.be.rejected;
  });
});
