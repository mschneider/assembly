import { PublicKey, Transaction } from "@solana/web3.js";

export interface WalletProvider {
  name: string;
  url: string;
  icon: string;
  adapter: any;
}
