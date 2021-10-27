import useWalletStore from "../stores/useWalletStore";
import { getOwnedTokenAccounts } from "../tokens";

export async function fetchWalletTokenAccounts() {
  const { connected, connection, wallet, set } = useWalletStore.getState();

  const walletOwner = wallet.current?.publicKey;

  if (connected && walletOwner) {
    const ownedTokenAccounts = await getOwnedTokenAccounts(
      connection.current,
      walletOwner
    );

    console.log(
      "fetchWalletTokenAccounts",
      connected,
      ownedTokenAccounts.map((t) => t.account.mint.toBase58())
    );

    set((s) => {
      s.tokenAccounts = ownedTokenAccounts;
    });
  } else {
    set((s) => {
      s.tokenAccounts = [];
    });
  }
}
