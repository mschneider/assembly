import { useState } from 'react';
import useWallet from '../hooks/useWallet';
import useWalletStore from '../stores/useWalletStore'


const ConnectWallet = () => {

  const { connected, wallet, set: setWalletStore } = useWalletStore(s => s);

  const [isSelectingWallet, setSelectingWallet] = useState(false); 

  const connect = (desiredWallet) => {
    setSelectingWallet(false)
    if (connected) {
      wallet.current.disconnect()
    }

    setWalletStore(s => {
      s.wallet.selected = desiredWallet
    })

    // wait for wallet store to update
    setTimeout(async () => {
      useWalletStore.getState().wallet.current.connect()
    }, 50);
  }

  const toggleConnect = async () => {
    if (connected) {
      wallet.current.disconnect()
    } else {
      wallet.current.connect()
    }
  }


  return (
    <div className="grid grid-cols-4 justify-items-end p-4">

      { isSelectingWallet
      ?
        <>
          <div></div>
          <div>
            <button className="btn" onClick={() => connect('Phantom')}>Phantom</button>
          </div>
          {/* <div>
            <button class="btn success" onClick={() => connect('Slope')}>Slope</button>
          </div> */}
          <div>
            <button className="btn primary" onClick={() => connect('Sollet')}>Sollet</button>
          </div>

          <div>
            <button className="btn error" onClick={() => setSelectingWallet(false)}>Cancel</button>
          </div>
        </>
      :
        <>
        <div>
          
        </div>
          <div>
            
          </div>
          <div>
            <button className={`btn ${connected || 'success'}`} onClick={toggleConnect}>
              {connected ? 'Disconnect' : 'Connect'}
            </button>
          </div>
          <div>
            <button className="btn warning" onClick={() => setSelectingWallet(true)}>Switch Wallet</button>
          </div>
        </>
      }
    </div>
  )
}


export default function Home() {
  useWallet()

  const { connected, wallet, tokenAccounts } = useWalletStore(s => s);

  return (
    <div className="mt-16">

      <ConnectWallet/>

      <div className="grid grid-flow-col grid-cols-3 gap-2">
        <div className="container">
          <label className="title">Available Budget</label>
          <p className="w-64">500,000,000.00 USDC</p>
        </div>

        <div className="container">
          <label className="title">Grants Distributed</label>
          <p className="w-64">12,345.00 USDC</p>
        </div>


        <div className="container">
          <label className="title">Ends in</label>
          <p className="w-64">12 days</p>
        </div>
      </div>

      {tokenAccounts.map( t => (
        <div key={t.publicKey.toBase58()}> {t.publicKey.toBase58()}: {t.account.amount.toString()}</div>
      ))}
    </div>
  )
}
