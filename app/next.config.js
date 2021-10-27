const withTM = require("next-transpile-modules")([
  "@project-serum/sol-wallet-adapter",
  "@solana/wallet-adapter-base",
  "@solana/wallet-adapter-phantom",
  "@solana/wallet-adapter-slope",
  "@solana/wallet-adapter-sollet",
]);

module.exports = withTM({
  experimental: {
    externalDir: true,
  },
});
