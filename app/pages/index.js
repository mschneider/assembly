import useWalletStore from '../stores/useWalletStore'

export default function Home() {

  const { connected, tokenAccounts } = useWalletStore(s => s);

  console.log(tokenAccounts)

  return (
    <div>connected: {connected}</div>
  )
}
