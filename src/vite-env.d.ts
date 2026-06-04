/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEARARC_CONTRACT_ADDRESS?: string;
  readonly VITE_ARC_CHAIN_ID?: string;
  readonly VITE_ARC_RPC_URL?: string;
  readonly VITE_ARC_CHAIN_NAME?: string;
  readonly VITE_ARC_NATIVE_CURRENCY_NAME?: string;
  readonly VITE_ARC_NATIVE_CURRENCY_SYMBOL?: string;
  readonly VITE_ARC_BLOCK_EXPLORER_URL?: string;
  readonly VITE_DEARARC_DEPLOY_BLOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
