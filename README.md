# Arcana Signal

Arcana Signal is the web interface for DearARC v2, a deterministic on-chain
intention and state protocol for ARC wallets.

The app lets a wallet submit a structured message:

- `text`
- `type`: `wish`, `goal`, `question`, or `thought`
- `intensity`: `1` to `5`

The frontend uses a transaction hash as a deterministic seed, derives a state
vector, and displays a state report, reflection, next signal, and rolling wallet
profile.

## Run

```bash
npm install
npm run dev
```

## Modes

The app supports four modes:

- Local deterministic mode: no contract config, creates local tx-like hashes.
- Write-only chain mode: contract address is set, wallet can submit messages.
- Onchain event mode: contract address, ARC RPC URL, chain id, and deploy block
  are set, so wallet profiles are rebuilt from contract events.
- Dual-contract event mode: Signal and Archive contracts are set. Users choose
  the lower-fee event record or the contract-stored Archive record before
  approving a transaction. History is merged from both contracts.

Copy `.env.example` to `.env` and fill the ARC values:

```bash
VITE_DEARARC_CONTRACT_ADDRESS=
VITE_DEARARC_SIGNAL_CONTRACT_ADDRESS=
VITE_DEARARC_SIGNAL_DEPLOY_BLOCK=0
VITE_DEARARC_ARCHIVE_CONTRACT_ADDRESS=
VITE_DEARARC_ARCHIVE_DEPLOY_BLOCK=0
VITE_ARC_CHAIN_ID=
VITE_ARC_RPC_URL=
VITE_ARC_CHAIN_NAME=ARC Testnet
VITE_ARC_NATIVE_CURRENCY_NAME=USDC
VITE_ARC_NATIVE_CURRENCY_SYMBOL=USDC
VITE_ARC_BLOCK_EXPLORER_URL=https://testnet.arcscan.app
VITE_DEARARC_DEPLOY_BLOCK=0
```

## Contract

`contracts/DearArcMessages.sol` contains the minimal ARC event contract:

```solidity
function createMessage(
  string calldata text,
  uint8 messageType,
  uint8 intensity
) external
```

The state engine stays off-chain and deterministic in `src/stateEngine.ts`.

## Deploy Contract

Set these private values in `.env` locally:

```bash
VITE_ARC_RPC_URL=
VITE_ARC_CHAIN_ID=
DEPLOYER_PRIVATE_KEY=
```

Then run:

```bash
npm run deploy:contract
```

The script prints:

- `VITE_DEARARC_CONTRACT_ADDRESS`
- `VITE_DEARARC_DEPLOY_BLOCK`

Add those to `.env`, restart Vite, and the app can read contract events for
wallet profiles.

## Deploy Frontend

Netlify is configured with `netlify.toml`:

- build command: `npm run build`
- publish directory: `dist`

Set the public `VITE_*` variables in the hosting dashboard before deploying.
