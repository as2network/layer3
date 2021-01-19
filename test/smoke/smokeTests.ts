import request from "request-promise";
import { KitsuneTools } from "../../src/integrations/kitsune";
import { ethers } from "ethers";
import config from "../../src/dataEntities/config";
import { getJsonRPCProvider } from "../../src/utils";
let account0: string,
  account1: string,
  channelContract: ethers.Contract,
  hashState: string,
  disputePeriod: number;

const mineBlock = async (wallet: ethers.Signer) => {
  const tx = await wallet.sendTransaction({
    to: "0x0000000000000000000000000000000000000000",
    value: 1,
  });
  await tx.wait();
};
const mineBlocks = async (wallet: ethers.Signer, blockCount: number) => {
  for (let index = 0; index < blockCount; index++) {
    await mineBlock(wallet);
  }
};

let setup = async () => {
  // accounts
  const provider = getJsonRPCProvider(config.jsonRpcUrl);
  const accounts = await provider.listAccounts();
  account0 = accounts[0];
  account1 = accounts[1];

  // set the dispute period
  disputePeriod = 15;

  // contract
  const channelContractFactory = new ethers.ContractFactory(
    KitsuneTools.ContractAbi,
    KitsuneTools.ContractBytecode,
    provider.getSigner()
  );
  channelContract = await channelContractFactory.deploy(
    [account0, account1],
    disputePeriod
  );
  hashState = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("face-off"));
};

let execute = async () => {
  const provider = getJsonRPCProvider(config.jsonRpcUrl);
  const wallet = new ethers.Wallet(config.responderKey, provider);
  const round = 1,
    setStateHash = KitsuneTools.hashForSetState(
      hashState,
      round,
      channelContract.address
    ),
    sig0 = await provider
      .getSigner(account0)
      .signMessage(ethers.utils.arrayify(setStateHash)),
    sig1 = await provider
      .getSigner(account1)
      .signMessage(ethers.utils.arrayify(setStateHash)),
    expiryPeriod = disputePeriod + 1;
  const appointmentRequest = {
    expiryPeriod,
    stateUpdate: {
      contractAddress: channelContract.address,
      hashState,
      round,
      signatures: [sig0, sig1],
    },
  };

  await request.post(
    `http://${config.hostName}:${config.hostPort}/appointment`,
    {
      json: appointmentRequest,
    }
  );

  // now register a callback on the setstate event and trigger a response
  const setStateEvent = "EventEvidence(uint256, bytes32)";
  let successResult = { success: false };
  channelContract.on(setStateEvent, () => {
    channelContract.removeAllListeners(setStateEvent);
    successResult.success = true;
  });

  // trigger a dispute
  const tx = await channelContract.triggerDispute();
  await tx.wait();

  // mine some blocks to ensure the watcher catches up
  await mineBlocks(wallet, 13);

  // wait for the success result
  await waitForPredicate(successResult, (s) => s.success, 1000);
};

// assess the value of a predicate after a timeout, throws if predicate does not evaluate to true
const waitForPredicate = <T1>(
  successResult: T1,
  predicate: (a: T1) => boolean,
  timeout: number
) => {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (predicate(successResult)) {
        resolve();
      } else {
        reject("Predicate not satisfied.");
      }
    }, timeout);
  });
};

let flow = async () => {
  await setup();
  await execute();
};
console.log("Executing smoke tests");
flow().then(
  () => {
    console.log("Tests passed.");
    process.exit(0);
  },
  (err) => {
    console.log("Tests failed!");
    console.log(err);
    process.exit(1);
  }
);
