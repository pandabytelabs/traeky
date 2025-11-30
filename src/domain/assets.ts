export type AssetMetadata = {
  symbol: string;
  name: string;
  /**
   * Optional base URL for a transaction explorer where the tx-id will be appended.
   * Example: "https://etherscan.io/tx/".
   */
  explorerBaseUrl?: string;
  /**
   * Optional CoinGecko asset id for price lookups (e.g. "bitcoin", "matic-network").
   */
  coingeckoId?: string;
};

// Note: This list intentionally contains a curated set of popular assets.
// It can be extended at any time without touching the calling code.
const ASSET_METADATA: Record<string, AssetMetadata> = {
  IOTA: { symbol: "IOTA", name: "IOTA", explorerBaseUrl: "https://explorer.iota.org/txblock/", coingeckoId: "iota"},
  BTC: { symbol: "BTC", name: "Bitcoin", explorerBaseUrl: "https://mempool.space/tx/", coingeckoId: "bitcoin"},
  ETH: { symbol: "ETH", name: "Ethereum", explorerBaseUrl: "https://etherscan.io/tx/", coingeckoId: "ethereum"},
  USDT: { symbol: "USDT", name: "Tether", explorerBaseUrl: "https://etherscan.io/tx/", coingeckoId: "tether"},
  USDC: { symbol: "USDC", name: "USD Coin", explorerBaseUrl: "https://etherscan.io/tx/", coingeckoId: "usd-coin"},
  BNB: { symbol: "BNB", name: "BNB", explorerBaseUrl: "https://bscscan.com/tx/", coingeckoId: "binancecoin"},
  XRP: { symbol: "XRP", name: "XRP", explorerBaseUrl: "https://livenet.xrpl.org/transactions/", coingeckoId: "ripple"},
  ADA: { symbol: "ADA", name: "Cardano", explorerBaseUrl: "https://cardanoscan.io/transaction/", coingeckoId: "cardano"},
  SOL: { symbol: "SOL", name: "Solana", explorerBaseUrl: "https://solscan.io/tx/", coingeckoId: "solana"},
  DOGE: { symbol: "DOGE", name: "Dogecoin", explorerBaseUrl: "https://dogechain.info/tx/", coingeckoId: "dogecoin"},
  TRX: { symbol: "TRX", name: "TRON", explorerBaseUrl: "https://tronscan.org/#/transaction/", coingeckoId: "tron"},
  DOT: { symbol: "DOT", name: "Polkadot", explorerBaseUrl: "https://polkascan.io/polkadot/transaction/", coingeckoId: "polkadot"},
  MATIC: { symbol: "MATIC", name: "Polygon", explorerBaseUrl: "https://polygonscan.com/tx/", coingeckoId: "matic-network"},
  LTC: { symbol: "LTC", name: "Litecoin", explorerBaseUrl: "https://blockchair.com/litecoin/transaction/", coingeckoId: "litecoin"},
  SHIB: { symbol: "SHIB", name: "Shiba Inu", explorerBaseUrl: "https://etherscan.io/tx/", coingeckoId: "shiba-inu"},
  AVAX: { symbol: "AVAX", name: "Avalanche", explorerBaseUrl: "https://snowtrace.io/tx/", coingeckoId: "avalanche-2"},
  LINK: { symbol: "LINK", name: "Chainlink", explorerBaseUrl: "https://etherscan.io/tx/", coingeckoId: "chainlink"},
  XLM: { symbol: "XLM", name: "Stellar", explorerBaseUrl: "https://stellarchain.io/tx/", coingeckoId: "stellar"},
  UNI: { symbol: "UNI", name: "Uniswap", explorerBaseUrl: "https://etherscan.io/tx/", coingeckoId: "uniswap"},
  XMR: { symbol: "XMR", name: "Monero", coingeckoId: "monero"},
  ETC: { symbol: "ETC", name: "Ethereum Classic", explorerBaseUrl: "https://etcblockexplorer.com/tx/", coingeckoId: "ethereum-classic"},
  BCH: { symbol: "BCH", name: "Bitcoin Cash", explorerBaseUrl: "https://blockchair.com/bitcoin-cash/transaction/", coingeckoId: "bitcoin-cash"},
  ATOM: { symbol: "ATOM", name: "Cosmos Hub", explorerBaseUrl: "https://www.mintscan.io/cosmos/txs/", coingeckoId: "cosmos"},
  OP: { symbol: "OP", name: "Optimism", explorerBaseUrl: "https://optimistic.etherscan.io/tx/", coingeckoId: "optimism"},
  ARB: { symbol: "ARB", name: "Arbitrum", explorerBaseUrl: "https://arbiscan.io/tx/", coingeckoId: "arbitrum"},
  AAVE: { symbol: "AAVE", name: "Aave", explorerBaseUrl: "https://etherscan.io/tx/", coingeckoId: "aave"},
  SAND: { symbol: "SAND", name: "The Sandbox", explorerBaseUrl: "https://etherscan.io/tx/", coingeckoId: "the-sandbox"},
  MANA: { symbol: "MANA", name: "Decentraland", explorerBaseUrl: "https://etherscan.io/tx/", coingeckoId: "decentraland"},
  GRT: { symbol: "GRT", name: "The Graph", explorerBaseUrl: "https://etherscan.io/tx/", coingeckoId: "the-graph"},
  RUNE: { symbol: "RUNE", name: "THORChain", explorerBaseUrl: "https://viewblock.io/thorchain/tx/", coingeckoId: "thorchain"},
  STX: { symbol: "STX", name: "Stacks", explorerBaseUrl: "https://explorer.hiro.so/txid/", coingeckoId: "stacks"},
  INJ: { symbol: "INJ", name: "Injective", explorerBaseUrl: "https://www.mintscan.io/injective/txs/", coingeckoId: "injective-protocol"},
  SUI: { symbol: "SUI", name: "Sui", explorerBaseUrl: "https://explorer.sui.io/tx/", coingeckoId: "sui"},
  TON: { symbol: "TON", name: "Toncoin", explorerBaseUrl: "https://tonviewer.com/transaction/", coingeckoId: "toncoin"},
  CRO: { symbol: "CRO", name: "Cronos", explorerBaseUrl: "https://cronoscan.com/tx/", coingeckoId: "crypto-com-chain"},
};

export function getAssetMetadata(symbolOrName: string | null | undefined): AssetMetadata | null {
  if (!symbolOrName) {
    return null;
  }
  const key = symbolOrName.trim().toUpperCase();

  // 1) Direct symbol lookup (e.g. "BTC")
  const bySymbol = ASSET_METADATA[key];
  if (bySymbol) {
    return bySymbol;
  }

  // 2) Fallback: lookup by full name (e.g. "BITCOIN" -> BTC)
  for (const meta of Object.values(ASSET_METADATA)) {
    if (meta.name.toUpperCase() === key) {
      return meta;
    }
  }

  return null;
}

export function normalizeAssetSymbol(input: string | null | undefined): string | null {
  if (!input) {
    return null;
  }
  const meta = getAssetMetadata(input);
  if (meta) {
    return meta.symbol;
  }
  return input.trim();
}

export function getTxExplorerUrl(
  symbol: string | null | undefined,
  txId: string | null | undefined,
): string | null {
  if (!symbol || !txId) {
    return null;
  }
  const meta = getAssetMetadata(symbol);
  if (!meta || !meta.explorerBaseUrl) {
    return null;
  }
  return `${meta.explorerBaseUrl}${txId}`;
}

export function getCoingeckoIdForSymbol(symbol: string | null | undefined): string | null {
  if (!symbol) {
    return null;
  }
  const meta = getAssetMetadata(symbol);
  return meta?.coingeckoId ?? null;
}

