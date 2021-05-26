const fs = require("fs");
import { verifyAirdrop } from "./verify-merkle-root";

const mainnet = JSON.parse(
  fs.readFileSync("mainnetProofs.json", { encoding: "utf8" })
);
verifyAirdrop(mainnet);

const xdai = JSON.parse(
  fs.readFileSync("xdaiProofs.json", { encoding: "utf8" })
);
verifyAirdrop(xdai);
