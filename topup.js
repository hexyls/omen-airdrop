const { ethers } = require("ethers");
const fs = require("fs");

// set private key of funding account
const PK = "";
const provider = new ethers.providers.JsonRpcBatchProvider(
  "https://rpc.xdaichain.com/"
);
const wallet = new ethers.Wallet(PK, provider);

const log = (str) => {
  process.stdout.clearLine();
  process.stdout.cursorTo(0);
  process.stdout.write(str);
};

const run = async () => {
  // must be run after xdaiProofs.json is generated
  const content = JSON.parse(fs.readFileSync("xdaiProofs.json"));
  const addresses = Object.keys(content.claims);
  const value = ethers.utils.parseUnits("0.1");
  for (let i = 0; i < addresses.length; i++) {
    log(`${i}/${addresses.length}`);
    const to = addresses[i];
    const balance = await provider.getBalance(to);
    if (balance.lt(value)) {
      const tx = await wallet.sendTransaction({ to, value });
      await tx.wait();
    }
  }
};

run();
