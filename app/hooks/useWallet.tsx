import { useEffect, useMemo } from "react";

import useWalletStore from "../stores/useWalletStore";
import { notify } from "../actions/notify";

// import useInterval from "./useInterval";
import useLocalStorage from "./useLocalStorage";
import { fetchWalletTokenAccounts } from "../actions/fetchWalletTokenAccounts";
import {
  DEFAULT_PROVIDER,
  getWalletProviderByName,
  WalletAdapter,
} from "../wallet-adapters";

export default function useWallet() {
  const { connected, connection, wallet, set } = useWalletStore((s) => s);

  const [saved, setSaved] = useLocalStorage("wallet", DEFAULT_PROVIDER.name);

  useEffect(() => {
    if (wallet.selected && wallet.selected != saved) {
      setSaved(wallet.selected);
    }
  }, [wallet.selected]);

  const provider = useMemo(
    () => getWalletProviderByName(wallet.selected),
    [wallet.selected]
  );

  // initialize adapter whenever connection or provider changes
  useEffect(() => {
    if (provider) {
      const updateAdapter = () => {
        // hack to also update wallet synchronously in case it disconnects
        const adapter = new provider.adapter(
          provider.url,
          connection.url
        ) as WalletAdapter;
        set((state) => {
          state.wallet.icon = provider.icon;
          state.wallet.current = adapter;
        });
      };

      if (document.readyState === "complete") {
        updateAdapter();
      } else {
        // wait to ensure that browser extensions are loaded
        const listener = () => {
          updateAdapter();
          window.removeEventListener("load", listener);
        };
        window.addEventListener("load", listener);
        return () => window.removeEventListener("load", listener);
      }
    }
  }, [provider, connection.url]);

  // subscripe to wallet events whenever adapter changes
  useEffect(() => {
    if (!wallet.current) return;
    wallet.current.on("connect", async () => {
      set((state) => {
        state.connected = true;
      });
      notify({
        message: "Wallet connected",
        description:
          "Connected to wallet " +
          wallet.current.publicKey.toString().substr(0, 5) +
          "..." +
          wallet.current.publicKey.toString().substr(-5),
      });
      await fetchWalletTokenAccounts();
    });
    wallet.current.on("disconnect", () => {
      set((s) => {
        s.connected = false;
        s.tokenAccounts = [];
      });
      notify({
        type: "info",
        message: "Disconnected from wallet",
      });
    });
    return () => {
      wallet.current?.disconnect?.();
      set((s) => {
        s.connected = false;
      });
    };
  }, [wallet.current]);

  /*
  // fetch on page load
  useEffect(() => {
    const pageLoad = async () => {
      console.log("pageLoad");
    };
    pageLoad();
  }, []);

  // refresh regularly
  const SECONDS = 1000;
  useInterval(async () => {
    console.log("refresh");
  }, 10 * SECONDS);
  */

  return { connected, wallet: wallet.current };
}
