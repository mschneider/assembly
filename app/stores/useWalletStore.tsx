import { WalletAdapter } from "@solana/wallet-adapter-base";
import { Connection } from "@solana/web3.js";
import produce from "immer";
import create, { State } from "zustand";
import { ProgramAccount, TokenAccount } from "../../lib/tokens";
import { WALLETS } from "../hooks/useWallet";

interface WalletStore extends State {
  connected: boolean;
  connection: {
    current: Connection;
    selected: string;
    url: string;
  };
  wallet: {
    current: WalletAdapter;
    selected: string;
    icon: string;
  };
  tokenAccounts: ProgramAccount<TokenAccount>[];
  set: (fn: (_: WalletStore) => void) => void;
}

export const ENDPOINTS = [
  {
    id: "mainnet",
    url: "https://mango.rpcpool.com",
  },
  {
    id: "devnet",
    url: "https://mango.devnet.solana.com",
  },
];

const endpoint = ENDPOINTS.find(
  (e) => e.id === (process.env.NEXT_PUBLIC_ENDPOINT ?? "mainnet")
);
const initialConnectionState = {
  current: new Connection(endpoint.url, "recent"),
  selected: endpoint.id,
  url: endpoint.url,
};

const wallet = WALLETS[0];
const initialWalletState = {
  current: wallet.adapter(undefined),
  selected: wallet.name,
  icon: wallet.icon,
};

const useWalletStore = create<WalletStore>((set, _get) => ({
  connected: false,
  connection: initialConnectionState,
  wallet: initialWalletState,
  tokenAccounts: [],
  set: (fn: (_: WalletStore) => void) => set(produce(fn)),
}));

export default useWalletStore;
