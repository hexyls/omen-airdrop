const { request, gql } = require("graphql-request");
const { ethers, utils, BigNumber, FixedNumber } = require("ethers");
const { parseBalanceMap } = require("./src/parse-balance-map.ts");
const { verifyAirdrop } = require("./scripts/verify-merkle-root.ts");
const fs = require("fs");

const provider = new ethers.providers.JsonRpcBatchProvider(
  "https://mainnet.infura.io/v3/9c6788bb15234036991db4637638429f"
);
const DXD_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "from", type: "address" },
      { indexed: true, internalType: "address", name: "to", type: "address" },
      {
        indexed: false,
        internalType: "uint256",
        name: "value",
        type: "uint256",
      },
    ],
    name: "Transfer",
    type: "event",
  },
  {
    constant: true,
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    payable: false,
    stateMutability: "view",
    type: "function",
  },
  {
    constant: true,
    inputs: [],
    name: "totalSupply",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    payable: false,
    stateMutability: "view",
    type: "function",
  },
];

const DXD_MAINNET_ADDRESS = "0xa1d65E8fB6e87b60FECCBc582F7f97804B725521";
const dxd = new ethers.Contract(DXD_MAINNET_ADDRESS, DXD_ABI, provider);
const hundred = FixedNumber.from(100);
const DXD_HOLDERS_REWARD = FixedNumber.from(utils.parseUnits("4200000")); // DXD Holders: 4.2% [4,200,000 OMN]

const testing = true;
const testingAddresses = [
  "0x81a94868572ea6e430f9a72ed6c4afb8b5003fdf",
  "0x11aa7ef6d9fb561b2050c90f655286ea2409a477",
  "0x3111327edd38890c3fe564afd96b4c73e8101747",
  "0x4502166be703312eae5137ad7399393b09471f27",
  "0xa493f3Adf76560092088a61e9e314a08D0B1B2b8",
];

const clearJson = () => {
  try {
    fs.unlinkSync("dxdProofs.json");
  } catch (err) {}
};

// swapr
const SWAPR_SUBGRAPH =
  "https://api.thegraph.com/subgraphs/name/luzzif/swapr-mainnet-alpha";
const swaprEthPair = ["0xb0dc4b36e0b4d2e3566d2328f6806ea0b76b4f13"];
const swaprUsdtPair = ["0x67bf56e4cb13363cc1a5f243e51354e7b72a8930"];

// uniswap
const UNI_SUBGRAPH =
  "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2";
const uniPair = ["0x1c9052e823b5f4611ef7d5fb4153995b040ccbf5"];

// honey swap
const HONEY_SUBGRAPH =
  "https://api.thegraph.com/subgraphs/name/1hive/honeyswap-xdai";
const honeyPair = ["0x9d7c92ad2becbc3899b83f3e3146bdf339202a80"];

const LP_QUERY = gql`
  query LPS($pairs: [ID!]!) {
    liquidityPositions(
      where: { pair_in: $pairs, liquidityTokenBalance_gt: "0" }
    ) {
      pair {
        totalSupply
        reserve0
      }
      user {
        id
      }
      liquidityTokenBalance
    }
  }
`;

// balancer
const BALANCER_SUBGRAPH =
  "https://api.thegraph.com/subgraphs/name/balancer-labs/balancer";
const POOLS_QUERY = gql`
    query getPools($block: Int!) {
        data: pools(
            block: { number: $block }
            where: {
                tokensList_contains: [
                    "${DXD_MAINNET_ADDRESS.toLowerCase()}"
                ]
                liquidity_gt: 0
            }
        ) {
            id
            totalShares
            tokens(where: { address: "${DXD_MAINNET_ADDRESS.toLowerCase()}" }) {
              balance
            }
        }
    }
`;

const LIQUIDITY_PROVIDERS_QUERY = gql`
  query getLps($block: Int!, $poolIds: [ID!]!) {
    data: poolShares(
      block: { number: $block }
      where: { poolId_in: $poolIds, balance_gt: 0 }
    ) {
      poolId {
        id
      }
      balance
      userAddress {
        id
      }
    }
  }
`;

const isContract = async (addr) => {
  const code = await provider.getCode(addr);
  if (code === "0x") {
    return false;
  }
  return true;
};

const blacklist = [
  "0x0000000000000000000000000000000000000000",
  "0x0000000000000000000000000000000000000001",
];

const included = async (address) => {
  if (await isContract(address)) {
    return false;
  }
  if (blacklist.includes(address)) {
    return false;
  }
  return true;
};

const addLps = async (addresses, balanceMap, subgraph, pairs) => {
  const data = await request(subgraph, LP_QUERY, { pairs });
  for (let i = 0; i < data.liquidityPositions.length; i++) {
    const position = data.liquidityPositions[i];
    const address = utils.getAddress(position.user.id);
    const totalSupply = FixedNumber.from(position.pair.totalSupply);
    const balance = FixedNumber.from(position.liquidityTokenBalance);
    const reserve = FixedNumber.from(position.pair.reserve0);
    const perc = balance.divUnsafe(totalSupply).mulUnsafe(hundred);
    const dxd = FixedNumber.from(
      utils.parseUnits(perc.divUnsafe(hundred).mulUnsafe(reserve).toString())
    );
    if (await included(address)) {
      addresses.add(address);
      const existingBal = balanceMap[address];
      balanceMap[address] = existingBal ? existingBal.addUnsafe(dxd) : dxd;
    }
  }
};

const addBalancerLps = async (addresses, balanceMap, block) => {
  // get all balancer pools
  const pools = await request(BALANCER_SUBGRAPH, POOLS_QUERY, { block });

  // get all lps for each pool
  const lps = await request(BALANCER_SUBGRAPH, LIQUIDITY_PROVIDERS_QUERY, {
    block,
    poolIds: pools.data.map((pool) => pool.id),
  });

  // find how much DXD is in each pool and what % is owned by each LP
  for (let i = 0; i < pools.data.length; i++) {
    const pool = pools.data[i];
    const positions = lps.data.filter((lp) => lp.poolId.id === pool.id);
    const totalSupply = FixedNumber.from(pool.totalShares);
    const reserve = FixedNumber.from(pool.tokens[0].balance);
    for (let j = 0; j < positions.length; j++) {
      const position = positions[j];
      const address = utils.getAddress(position.userAddress.id);
      const balance = FixedNumber.from(position.balance);
      const perc = balance.divUnsafe(totalSupply).mulUnsafe(hundred);
      const dxd = FixedNumber.from(
        utils.parseUnits(perc.divUnsafe(hundred).mulUnsafe(reserve).toString())
      );
      if (await included(address)) {
        addresses.add(address);
        const existingBal = balanceMap[address];
        balanceMap[address] = existingBal ? existingBal.addUnsafe(dxd) : dxd;
      }
    }
  }
};

const run = async () => {
  clearJson();

  const additional = testing ? testingAddresses : [];
  const cache = JSON.parse(fs.readFileSync("dxdCache.json"));
  const addresses = new Set(
    [...cache, ...additional].map((address) => utils.getAddress(address))
  );

  const blockNumber = await provider.getBlockNumber();

  // fetch dxd balances
  console.log("fetching balances");
  const balances = {};
  if (testing) {
    for (let i = 0; i < testingAddresses.length; i++) {
      const address = utils.getAddress(testingAddresses[i]);
      balances[address] = FixedNumber.from("20000000000000000000");
    }
  }

  await Promise.all(
    Array.from(addresses).map(async (address) => {
      const balance = FixedNumber.from(await dxd.balanceOf(address));
      balances[address] = balance;
    })
  );

  // add lps
  console.log("adding swapr dxd/eth lps");
  await addLps(addresses, balances, SWAPR_SUBGRAPH, swaprEthPair);

  console.log("adding swapr dxd/usdt lps");
  await addLps(addresses, balances, SWAPR_SUBGRAPH, swaprUsdtPair);

  console.log("adding uniswap dxd/eth lps");
  await addLps(addresses, balances, UNI_SUBGRAPH, uniPair);

  console.log("adding honeyswap dxd/dai lps");
  await addLps(addresses, balances, HONEY_SUBGRAPH, honeyPair);

  console.log("adding balancer lps");
  await addBalancerLps(addresses, balances, blockNumber);

  const snapshotDXDSupply = Object.values(balances).reduce(
    (prev, curr) => prev.addUnsafe(curr),
    FixedNumber.from(0)
  );

  console.log("generating merkle root");

  // calculate rewards for each address
  entries = Array.from(addresses).reduce((prev, address, index) => {
    const balance = balances[address];
    if (balance && !balance.isZero()) {
      // The DXD holder airdrop is weighted, based at time of Snapshot.
      const perc = balance.divUnsafe(snapshotDXDSupply).mulUnsafe(hundred);
      const reward = perc.divUnsafe(hundred).mulUnsafe(DXD_HOLDERS_REWARD);
      if (!reward.isZero()) {
        const earnings = BigNumber.from(
          reward.toString().replace(".0", "")
        ).toHexString();
        return [...prev, { address, earnings, reasons: "" }];
      }
    }
    return prev;
  }, []);

  // make sure earnings are correct
  const totalEarnings = entries.reduce(
    (total, { earnings }) => total.add(earnings),
    BigNumber.from(0)
  );

  if (totalEarnings.gt(BigNumber.from(DXD_HOLDERS_REWARD))) {
    throw new Error("Total earnings higher than expected");
  }

  const proofs = parseBalanceMap(entries);
  verifyAirdrop(proofs);
  fs.writeFileSync("dxdProofs.json", JSON.stringify(proofs));
};

run();
