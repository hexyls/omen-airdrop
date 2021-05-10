import { BigNumber, utils } from "ethers";

const combinedHash = (first: Buffer, second: Buffer): Buffer => {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }

  return Buffer.from(
    utils
      .solidityKeccak256(
        ["bytes32", "bytes32"],
        [first, second].sort(Buffer.compare)
      )
      .slice(2),
    "hex"
  );
};

const toNode = (
  index: number | BigNumber,
  account: string,
  amount: BigNumber
): Buffer => {
  const pairHex = utils.solidityKeccak256(
    ["uint256", "address", "uint256"],
    [index, account, amount]
  );
  return Buffer.from(pairHex.slice(2), "hex");
};

export const verifyProof = (
  index: number | BigNumber,
  account: string,
  amount: BigNumber,
  proof: Buffer[],
  root: Buffer
): boolean => {
  let pair = toNode(index, account, amount);
  for (const item of proof) {
    pair = combinedHash(pair, item);
  }

  return pair.equals(root);
};

const getNextLayer = (elements: Buffer[]): Buffer[] => {
  return elements.reduce<Buffer[]>((layer, el, idx, arr) => {
    if (idx % 2 === 0) {
      // Hash the current element with its pair element
      layer.push(combinedHash(el, arr[idx + 1]));
    }

    return layer;
  }, []);
};

export const getRoot = (
  balances: { account: string; amount: BigNumber; index: number }[]
): Buffer => {
  let nodes = balances
    .map(({ account, amount, index }) => toNode(index, account, amount))
    // sort by lexicographical order
    .sort(Buffer.compare);

  // deduplicate any eleents
  nodes = nodes.filter((el, idx) => {
    return idx === 0 || !nodes[idx - 1].equals(el);
  });

  const layers = [];
  layers.push(nodes);

  // Get next layer until we reach the root
  while (layers[layers.length - 1].length > 1) {
    layers.push(getNextLayer(layers[layers.length - 1]));
  }

  return layers[layers.length - 1][0];
};
