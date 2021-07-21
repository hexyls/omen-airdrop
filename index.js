const { request, gql } = require("graphql-request");
const fs = require("fs");
const { ethers, utils, BigNumber } = require("ethers");
const { parseBalanceMap } = require("./src/parse-balance-map.ts");
const { verifyAirdrop } = require("./scripts/verify-merkle-root.ts");

const GRAPH_MAINNET_HTTP =
  "https://api.thegraph.com/subgraphs/name/protofire/omen";
const GRAPH_XDAI_HTTP =
  "https://api.thegraph.com/subgraphs/name/protofire/omen-xdai";
const CUTOFF_TIMESTAMP = 1619827200; // Epoch timestamp of May 1st, 2021 - Verify at https://www.epochconverter.com/
const TOTAL_USER_REWARD = utils.parseUnits("2000000"); // Omen Users: 2% [2,000,000 OMN]
const TOTAL_LP_REWARD = utils.parseUnits("700000"); // Omen LPs: 0.7% [700,000 OMN]

// queries
const userQuery = gql`
  query Trades($first: Int, $skip: Int) {
    fpmmTrades(first: $first, skip: $skip, where: { type: "Buy", creationTimestamp_lte: ${CUTOFF_TIMESTAMP} }) {
      creator {
        id
      }
      collateralAmountUSD
      transactionHash
    }
  }`;

const lpQuery = gql`
  query Lps($first: Int, $skip: Int) {
    fpmmLiquidities(first: $first, skip: $skip, where: { creationTimestamp_lte: ${CUTOFF_TIMESTAMP} }) {
      funder {
        id
      }
      transactionHash
    }
  }`;

// utils
const wait = () => new Promise((resolve) => setTimeout(resolve, 500));
const mainnetProvider = new ethers.providers.JsonRpcBatchProvider(
  "https://mainnet.infura.io/v3/9c6788bb15234036991db4637638429f"
);
const xdaiProvider = new ethers.providers.JsonRpcBatchProvider(
  "https://rpc.xdaichain.com/"
);
// FPMMDeterministicFactory addresses
const blacklist = {
  "0x89023DEb1d9a9a62fF3A5ca8F23Be8d87A576220": true,
  "0x9083A2B699c0a4AD06F63580BDE2635d26a3eeF0": true,
};

const testing = false;
const testingAddresses = [
  "0x81a94868572ea6e430f9a72ed6c4afb8b5003fdf",
  "0x11aa7ef6d9fb561b2050c90f655286ea2409a477",
  "0x3111327edd38890c3fe564afd96b4c73e8101747",
  "0x4502166be703312eae5137ad7399393b09471f27",
  "0xa493f3Adf76560092088a61e9e314a08D0B1B2b8",
];

const joinHexData = (hexData) => {
  return `0x${hexData
    .map((hex) => {
      const stripped = hex.replace(/^0x/, "");
      return stripped.length % 2 === 0 ? stripped : "0" + stripped;
    })
    .join("")}`;
};

const abiEncodePacked = (...params) => {
  return joinHexData(
    params.map(({ type, value }) => {
      const encoded = ethers.utils.defaultAbiCoder.encode([type], [value]);
      if (type === "bytes" || type === "string") {
        const bytesLength = parseInt(encoded.slice(66, 130), 16);
        return encoded.slice(130, 130 + 2 * bytesLength);
      }
      let typeMatch = type.match(/^(?:u?int\d*|bytes\d+|address)\[\]$/);
      if (typeMatch) {
        return encoded.slice(130);
      }
      if (type.startsWith("bytes")) {
        const bytesLength = parseInt(type.slice(5));
        return encoded.slice(2, 2 + 2 * bytesLength);
      }
      typeMatch = type.match(/^u?int(\d*)$/);
      if (typeMatch) {
        if (typeMatch[1] !== "") {
          const bytesLength = parseInt(typeMatch[1]) / 8;
          return encoded.slice(-2 * bytesLength);
        }
        return encoded.slice(-64);
      }
      if (type === "address") {
        return encoded.slice(-40);
      }
      throw new Error(`unsupported type ${type}`);
    })
  );
};

const isContract = async (provider, address) => {
  const code = await provider.getCode(address);
  return code && code !== "0x";
};

const log = (str) => {
  process.stdout.clearLine();
  process.stdout.cursorTo(0);
  process.stdout.write(str);
};

// paginate through a graphql query
const paginate = async (url, query, fn) => {
  const first = 100;
  let skip = 0;
  let processing = true;
  while (processing) {
    const data = await request(url, query, { first, skip });
    const key = Object.keys(data)[0];
    log(`${key} processed: ${skip}`);
    await fn(data[key]);
    if (data[key].length < first) {
      processing = false;
    }
    skip += first;
    await wait();
  }
};

const processUsers = async (url) => {
  // users on Omen before May 1st, 2021 as long as that user’s predictions have totalled at least $25.
  let accounts = {};

  await paginate(url, userQuery, async (data) => {
    // tally user spend across all trades
    accounts = data.reduce((prev, { creator, collateralAmountUSD }) => {
      const address = utils.getAddress(creator.id);
      const currentAmountUSD = prev[address];
      const tradeAmountUSD = Number(collateralAmountUSD);
      if (currentAmountUSD) {
        return { ...prev, [address]: currentAmountUSD + tradeAmountUSD };
      }
      return { ...prev, [address]: tradeAmountUSD };
    }, accounts);
  });

  // filter out addresses that spent less than the minimum
  const minSpend = 25;
  const eligibleAddresses = Object.keys(accounts).filter(
    (account) => accounts[account] >= minSpend && !blacklist[account]
  );

  return eligibleAddresses;
};

const realitioAbi = [
  "event LogNewQuestion(bytes32 indexed question_id, address indexed user, uint256 template_id, string question, bytes32 indexed content_hash, address arbitrator, uint32 timeout, uint32 opening_ts, uint256 nonce, uint256 created)",
];

const processLps = async (url, provider) => {
  // market creators / liquidity providers on Omen before May 1st, 2021
  let accounts = new Set();

  await paginate(url, lpQuery, async (data) => {
    await Promise.all(
      data.map(async (item, i) => {
        const address = utils.getAddress(item.funder.id);
        if (blacklist[address]) {
          // if the address is FPMMDeterministicFactory, check the tx for the proxy address
          let receipt;
          while (!receipt) {
            try {
              receipt = await provider.getTransactionReceipt(
                item.transactionHash
              );
            } catch (e) {}
            await wait();
          }
          const iface = new utils.Interface(realitioAbi);
          const event = receipt.logs
            .map((log) => {
              try {
                return iface.parseLog(log);
              } catch (e) {}
            })
            .find((log) => log);
          if (event) {
            const safeAddress = event.args.user;
            accounts.add(safeAddress);
          }
        } else {
          accounts.add(address);
        }
      })
    );
  });

  return [...accounts];
};

const getAddresses = async (url, provider) => {
  const users = await processUsers(url, provider);
  const lps = await processLps(url, provider);
  return { users, lps };
};

const getProxyOwner = async (proxyAddress) => {
  const proxyAbi = [
    "function getOwners() public view returns (address[] memory)",
  ];
  let owners;
  try {
    const proxy = new ethers.Contract(proxyAddress, proxyAbi, mainnetProvider);
    owners = await proxy.getOwners();
  } catch (e) {}

  if (!owners) {
    try {
      const proxy = new ethers.Contract(proxyAddress, proxyAbi, xdaiProvider);
      owners = await proxy.getOwners();
    } catch (e) {}
  }
  return owners && owners[0];
};

const getOwner = async (proxyAddress) => {
  if (testing && testingAddresses.includes(proxyAddress)) {
    return proxyAddress;
  }

  // get the owner of a proxy
  const owner = await getProxyOwner(proxyAddress);

  if (!owner) {
    // user has no proxy, likely interacted directly with a market
    return proxyAddress;
  }

  // we must handle proxies that are also owned by proxies
  const double = await getProxyOwner(owner);
  if (double) {
    return double;
  }

  return owner;
};

const getOwners = async (proxies, additonal = []) => {
  const owners = new Set([...additonal.map((addr) => utils.getAddress(addr))]);
  await Promise.all(
    proxies.map(async (proxy) => {
      const owner = await getOwner(proxy);
      owners.add(utils.getAddress(owner));
    })
  );
  return [...owners];
};

const getRelayProxyAddress = async (account) => {
  // calc the expected proxy address for a given user
  // check if that address is deployed on xdai
  const predeterminedSaltNonce =
    "0xcfe33a586323e7325be6aa6ecd8b4600d232a9037e83c8ece69413b777dabe65";
  const proxyCreationCode = `0x608060405234801561001057600080fd5b506040516101e73803806101e78339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260248152602001806101c36024913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505060aa806101196000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea265627a7a72315820cac3d62bfce6ec8b54a3201159f745e39db8fa84029fbcaa233ea75c5ceaac8264736f6c63430005100032496e76616c6964206d617374657220636f707920616464726573732070726f7669646564`;
  const relayProxyFactoryAddress = "0x7b9756f8A7f4208fE42FE8DE8a8CC5aA9A03f356";
  const masterCopy = "0x6851D6fDFAfD08c0295C392436245E5bc78B0185";
  const saltNonce = predeterminedSaltNonce;
  const salt = utils.keccak256(
    utils.defaultAbiCoder.encode(["address", "uint256"], [account, saltNonce])
  );
  const initCode = abiEncodePacked(
    { type: "bytes", value: proxyCreationCode },
    {
      type: "bytes",
      value: utils.defaultAbiCoder.encode(["address"], [masterCopy]),
    }
  );
  const proxyAddress = utils.getAddress(
    utils
      .solidityKeccak256(
        ["bytes", "address", "bytes32", "bytes32"],
        ["0xff", relayProxyFactoryAddress, salt, utils.keccak256(initCode)]
      )
      .slice(-40)
  );
  if (await isContract(xdaiProvider, proxyAddress)) {
    return proxyAddress;
  }
};

const clearJson = () => {
  try {
    fs.unlinkSync("mainnet.json");
    fs.unlinkSync("xdai.json");
    fs.unlinkSync("mainnetProofs.json");
    fs.unlinkSync("xdaiProofs.json");
  } catch (err) {}
};

const save = (name, obj) => {
  // save content to a json file
  let currentContent;
  try {
    currentContent = JSON.parse(fs.readFileSync(name));
  } catch (e) {}
  const newContent = currentContent ? [...currentContent, ...obj] : obj;
  fs.writeFileSync(name, JSON.stringify(newContent));
};

const getEntry = async (address, reward) => {
  const earnings = BigNumber.from(reward).toHexString();
  const entry = [{ address, earnings, reasons: "" }];

  if (testing && testingAddresses.includes(address)) {
    return { mainnet: true, entry };
  }

  // check if this user has a tight xdai integration proxy
  const proxy = await getRelayProxyAddress(address);

  if (proxy) {
    // if it does, the airdrop goes to the proxy
    return { entry: [{ address: proxy, earnings, reasons: "" }] };
  }

  // is this a mainnet account? check if nonce > 0
  const nonce = await mainnetProvider.getTransactionCount(address);
  if (nonce > 0) {
    return { mainnet: true, entry };
  }

  return { entry };
};

const addToJson = (data) => {
  if (data.mainnet) {
    return save("mainnet.json", data.entry);
  }

  save("xdai.json", data.entry);
};

const generateMerkleRoot = () => {
  const mainnetJson = JSON.parse(fs.readFileSync("mainnet.json"));
  const mainnetProofs = parseBalanceMap(mainnetJson);
  verifyAirdrop(mainnetProofs);
  fs.writeFileSync("mainnetProofs.json", JSON.stringify(mainnetProofs));

  const xdaiJson = JSON.parse(fs.readFileSync("xdai.json"));
  const xdaiProofs = parseBalanceMap(xdaiJson);
  verifyAirdrop(xdaiProofs);
  fs.writeFileSync("xdaiProofs.json", JSON.stringify(xdaiProofs));

  // verify allocations
  const totalMainnetAllocation = Object.values(mainnetProofs.claims).reduce(
    (p, a) => p.add(a.amount),
    BigNumber.from("0")
  );

  const totalxDaiAllocation = Object.values(xdaiProofs.claims).reduce(
    (p, a) => p.add(a.amount),
    BigNumber.from("0")
  );

  const totalExpected = TOTAL_USER_REWARD.add(TOTAL_LP_REWARD);
  const totalAllocation = totalMainnetAllocation.add(totalxDaiAllocation);
  if (
    !totalAllocation.eq(totalExpected) &&
    // allow 1000 wei in errors
    !(
      totalAllocation.lt(totalExpected) &&
      totalAllocation.gt(totalExpected.sub(1000))
    )
  ) {
    throw new Error("Balances are incorrect");
  }
};

const run = async () => {
  // clear json files if needed
  clearJson();

  // gather all relevant proxy addresses from mainnet and xdai
  console.log("\nfetching mainnet addresses");
  const mainnet = await getAddresses(GRAPH_MAINNET_HTTP, mainnetProvider);
  console.log("\nfetching xdai addresses");
  const xdai = await getAddresses(GRAPH_XDAI_HTTP, xdaiProvider);

  console.log("\nfetching proxy owners for user group");
  // calc reward per user
  const totalUserProxies = [...new Set([...mainnet.users, ...xdai.users])];
  const totalUsers = await getOwners(
    totalUserProxies,
    testing ? testingAddresses : []
  );
  const rewardPerUser = TOTAL_USER_REWARD.div(totalUsers.length);

  console.log("fetching proxy owners for LP group");
  // calc reward per creator / lp
  const totalLpProxies = [...new Set([...mainnet.lps, ...xdai.lps])];
  const totalLps = await getOwners(totalLpProxies);
  const rewardPerLp = TOTAL_LP_REWARD.div(totalLps.length);

  // define user rewards
  let rewards = {};
  rewards = totalUsers.reduce(
    (prev, address) => ({ ...prev, [address]: rewardPerUser.toString() }),
    rewards
  );

  // define lp rewards
  rewards = totalLps.reduce((prev, address) => {
    const currentReward = prev[address];
    if (currentReward) {
      return {
        ...prev,
        [address]: BigNumber.from(currentReward).add(rewardPerLp).toString(),
      };
    }
    return { ...prev, [address]: rewardPerLp.toString() };
  }, rewards);

  // add rewards to json file
  const dedupedUsers = [...new Set([...totalUsers, ...totalLps])];

  console.log("building json files");
  const entries = await Promise.all(
    dedupedUsers.map((address) => getEntry(address, rewards[address]))
  );

  for (let i = 0; i < entries.length; i++) {
    addToJson(entries[i]);
  }

  console.log("generating merkle root");
  generateMerkleRoot();
};

run();
