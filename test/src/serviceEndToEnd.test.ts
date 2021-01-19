import * as chai from "chai";
import "mocha";
import request from "request-promise";
import { KitsuneTools } from "../../src/integrations/kitsune";
import { ethers, Wallet } from "ethers";
import { PisaService } from "../../src/service";
import config from "../../src/dataEntities/config";
import Ganache from "ganache-core";
import { ChannelType } from "../../src/dataEntities";
import logger from "../../src/logger";
import StateChannelFactory from "../../src/integrations/kitsune/StateChannelFactory.json";
import levelup, { LevelUp } from "levelup";
import MemDown from "memdown";
import encodingDown from "encoding-down";
import { StatusCodeError } from "request-promise/errors";
logger.transports.forEach((l) => (l.level = "max"));

const ganache = Ganache.provider({
  mnemonic:
    "myth like bonus scare over problem client lizard pioneer submit female collect",
});
config.hostName = "localhost";
config.hostPort = 3000;
config.jsonRpcUrl = "http://localhost:8545";
config.responderKey =
  "0x6370fd033278c143179d81c5526140625662b8daa446c22ee2d73db3707e620c";
config.receiptKey =
  "0x6370fd033278c143179d81c5526140625662b8daa446c22ee2d73db3707e620c";
config.watcherResponseConfirmations = 0;

const provider = new ethers.providers.Web3Provider(ganache);
provider.pollingInterval = 100;

const expect = chai.expect;

describe("Service end-to-end", () => {
  let account0: string,
    account1: string,
    channelContract: ethers.Contract,
    hashState: string,
    disputePeriod: number,
    service: PisaService,
    db: LevelUp<encodingDown<string, any>>;

  beforeEach(async () => {
    const responderWallet = new ethers.Wallet(config.responderKey, provider);

    db = levelup(
      encodingDown<string, any>(MemDown(), {
        valueEncoding: "json",
      })
    );

    const signerWallet = new ethers.Wallet(config.receiptKey!, provider);

    service = new PisaService(
      config,
      provider,
      responderWallet,
      signerWallet,
      db
    );
    await service.start();

    // accounts
    const accounts = await provider.listAccounts();
    account0 = accounts[0];
    account1 = accounts[1];

    // set the dispute period, greater than the inspector period
    disputePeriod = 11;

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
  });

  afterEach(async () => {
    await service.stop();
    await db.close();
  });

  it("service cannot be accessed during startup", async () => {
    const watcherWallet = new ethers.Wallet(config.responderKey, provider);
    const signerWallet = new ethers.Wallet(config.receiptKey!, provider);

    const exService = new PisaService(
      { ...config, hostPort: config.hostPort + 1 },
      provider,
      watcherWallet,
      signerWallet,
      db
    );

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
    const appointment = {
      expiryPeriod,
      type: ChannelType.Kitsune,
      stateUpdate: {
        contractAddress: channelContract.address,
        hashState,
        round,
        signatures: [sig0, sig1],
      },
    };

    let res;
    try {
      res = await request.post(
        `http://${config.hostName}:${config.hostPort + 1}/appointment`,
        {
          json: appointment,
        }
      );

      chai.assert.fail();
    } catch (doh) {
      const statusCodeError = doh as StatusCodeError;
      expect(statusCodeError.statusCode).to.equal(503);
      expect(statusCodeError.error).to.equal(
        "Service initialising, please try again later."
      );
    }

    await exService.start();
    await exService.stop();
  });

  it("create channel, submit appointment, trigger dispute, wait for response", async () => {
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
    const appointment = {
      expiryPeriod,
      type: ChannelType.Kitsune,
      stateUpdate: {
        contractAddress: channelContract.address,
        hashState,
        round,
        signatures: [sig0, sig1],
      },
    };

    const res = await request.post(
      `http://${config.hostName}:${config.hostPort}/appointment`,
      {
        json: appointment,
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

    try {
      // wait for the success result
      await waitForPredicate(successResult, (s) => s.success, 400);
    } catch (doh) {
      // fail if we dont get it
      chai.assert.fail(
        true,
        false,
        "EventEvidence not successfully registered."
      );
    }
  }).timeout(3000);

  it("contains 'appointment' and 'signature' in the response; signature is correct", async () => {
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
    const appointment = {
      expiryPeriod,
      type: ChannelType.Kitsune,
      stateUpdate: {
        contractAddress: channelContract.address,
        hashState,
        round,
        signatures: [sig0, sig1],
      },
    };

    const startBlock = await provider.getBlockNumber();
    const endBlock = startBlock + appointment.expiryPeriod;

    const res = await request.post(
      `http://${config.hostName}:${config.hostPort}/appointment`,
      {
        json: appointment,
      }
    );

    const packedData = ethers.utils.solidityPack(
      ["string", "uint", "uint", "uint"],
      [
        channelContract.address, // locator===address in Kitsune
        appointment.stateUpdate.round,
        startBlock,
        endBlock,
      ]
    );
    const digest = ethers.utils.keccak256(packedData);
    const signer = new Wallet(config.receiptKey!);
    const sig = await signer.signMessage(digest);

    expect(res).to.deep.equal({
      startBlock: startBlock,
      endBlock: endBlock,
      locator: channelContract.address,
      nonce: appointment.stateUpdate.round,
      signature: sig,
    });
  });

  it("create channel, submit round = 0 too low returns 400", async () => {
    const round = 0,
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
    const appointment = {
      expiryPeriod,
      type: ChannelType.Kitsune,
      stateUpdate: {
        contractAddress: channelContract.address,
        hashState,
        round,
        signatures: [sig0, sig1],
      },
    };

    await failWithCode('400 - "Supplied appointment round', appointment);
  }).timeout(3000);

  it("create channel, submit round = -1 too low returns 400", async () => {
    const round = -1,
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
    const appointment = {
      expiryPeriod,
      type: ChannelType.Kitsune,
      stateUpdate: {
        contractAddress: channelContract.address,
        hashState,
        round,
        signatures: [sig0, sig1],
      },
    };

    await failWithCode('400 - "Supplied appointment round', appointment);
  }).timeout(3000);

  it("create channel, expiry = dispute period returns 400", async () => {
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
      expiryPeriod = disputePeriod;
    const appointment = {
      expiryPeriod,
      type: ChannelType.Kitsune,
      stateUpdate: {
        contractAddress: channelContract.address,
        hashState,
        round,
        signatures: [sig0, sig1],
      },
    };

    await failWithCode('400 - "Supplied appointment expiryPeriod', appointment);
  }).timeout(3000);

  it("create channel, expiry period = dispute period - 1 too low returns 400", async () => {
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
      expiryPeriod = disputePeriod - 1;
    const appointment = {
      expiryPeriod,
      type: ChannelType.Kitsune,
      stateUpdate: {
        contractAddress: channelContract.address,
        hashState,
        round,
        signatures: [sig0, sig1],
      },
    };

    await failWithCode('400 - "Supplied appointment expiryPeriod', appointment);
  }).timeout(3000);

  it("create channel, non existant contact returns 400", async () => {
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
    const appointment = {
      expiryPeriod,
      type: ChannelType.Kitsune,
      stateUpdate: {
        // random address
        contractAddress: "0x4bf3A7dFB3b76b5B3E169ACE65f888A4b4FCa5Ee",
        hashState,
        round,
        signatures: [sig0, sig1],
      },
    };

    await failWithCode(
      `400 - "No code found at address ${appointment.stateUpdate.contractAddress}`,
      appointment
    );
  }).timeout(3000);

  it("create channel, wrong bytecode contact returns 400", async () => {
    // deply an unrelated contract with different bytecode

    // contract
    const channelContractFactoryFactory = new ethers.ContractFactory(
      StateChannelFactory.abi,
      StateChannelFactory.bytecode,
      provider.getSigner()
    );
    const channelFactoryContract = await channelContractFactoryFactory.deploy();

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
    const appointment = {
      expiryPeriod,
      type: ChannelType.Kitsune,
      stateUpdate: {
        // random address
        contractAddress: channelFactoryContract.address,
        hashState,
        round,
        signatures: [sig0, sig1],
      },
    };

    await failWithCode(
      `400 - "Contract at: ${appointment.stateUpdate.contractAddress} does not have correct bytecode.`,
      appointment
    );
  }).timeout(3000);

  it("create channel, invalid contract address returns 400", async () => {
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
    const appointment = {
      expiryPeriod,
      type: ChannelType.Kitsune,
      stateUpdate: {
        // invalid address
        contractAddress: "0x4bf3A7dFB3b76b",
        hashState,
        round,
        signatures: [sig0, sig1],
      },
    };

    await failWithCode(
      `400 - "${appointment.stateUpdate.contractAddress} is not a valid address.`,
      appointment
    );
  }).timeout(3000);

  it("create channel, invalid state hash returns 400", async () => {
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
    const appointment = {
      expiryPeriod,
      type: ChannelType.Kitsune,
      stateUpdate: {
        contractAddress: channelContract.address,
        // invalid hash state
        hashState: "0x4bf3A7dFB3b76b",
        round,
        signatures: [sig0, sig1],
      },
    };

    await failWithCode(
      `400 - "Invalid bytes32: ${appointment.stateUpdate.hashState}`,
      appointment
    );
  }).timeout(3000);

  it("create channel, wrong state hash returns 400", async () => {
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
    const appointment = {
      expiryPeriod,
      type: ChannelType.Kitsune,
      stateUpdate: {
        contractAddress: channelContract.address,
        // substute the state hash for the set state hash
        hashState: setStateHash,
        round,
        signatures: [sig0, sig1],
      },
    };

    await failWithCode(
      '400 - "Party 0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1 not present in signatures',
      appointment
    );
  }).timeout(3000);

  it("create channel, wrong sig on hash returns 400", async () => {
    const expiryPeriod = disputePeriod + 1,
      round = 1,
      // setStateHash = KitsuneTools.hashForSetState(hashState, round, channelContract.address),
      // sign the wrong hash
      sig0 = await provider
        .getSigner(account0)
        .signMessage(ethers.utils.arrayify(hashState)),
      sig1 = await provider
        .getSigner(account1)
        .signMessage(ethers.utils.arrayify(hashState));
    const appointment = {
      expiryPeriod,
      type: ChannelType.Kitsune,
      stateUpdate: {
        contractAddress: channelContract.address,
        hashState,
        round,
        signatures: [sig0, sig1],
      },
    };

    await failWithCode(
      '400 - "Party 0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1 not present in signatures',
      appointment
    );
  }).timeout(3000);

  it("create channel, sigs by only one player returns 400", async () => {
    const expiryPeriod = disputePeriod + 1,
      round = 1,
      setStateHash = KitsuneTools.hashForSetState(
        hashState,
        round,
        channelContract.address
      ),
      // sign both with account 0
      sig0 = await provider
        .getSigner(account0)
        .signMessage(ethers.utils.arrayify(setStateHash)),
      sig1 = await provider
        .getSigner(account0)
        .signMessage(ethers.utils.arrayify(setStateHash));

    const appointment = {
      expiryPeriod,
      type: ChannelType.Kitsune,
      stateUpdate: {
        contractAddress: channelContract.address,
        hashState,
        round,
        signatures: [sig0, sig1],
      },
    };

    await failWithCode(
      '400 - "Party 0xFFcf8FDEE72ac11b5c542428B35EEF5769C409f0 not present in signatures',
      appointment
    );
  }).timeout(3000);

  it("create channel, missing sig returns 400", async () => {
    const expiryPeriod = disputePeriod + 1,
      round = 1,
      setStateHash = KitsuneTools.hashForSetState(
        hashState,
        round,
        channelContract.address
      ),
      //sig0 = await provider.getSigner(account0).signMessage(ethers.utils.arrayify(setStateHash)),
      sig1 = await provider
        .getSigner(account1)
        .signMessage(ethers.utils.arrayify(setStateHash));

    const appointment = {
      expiryPeriod,
      type: ChannelType.Kitsune,
      stateUpdate: {
        contractAddress: channelContract.address,
        hashState,
        round,
        signatures: [sig1],
      },
    };

    await failWithCode(
      '400 - "Incorrect number of signatures supplied',
      appointment
    );
  }).timeout(3000);

  it("create channel, sigs in wrong order returns 200", async () => {
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
    const appointment = {
      expiryPeriod,
      type: ChannelType.Kitsune,
      stateUpdate: {
        contractAddress: channelContract.address,
        hashState,
        round,
        signatures: [sig0, sig1],
      },
    };
    try {
      await request.post(
        `http://${config.hostName}:${config.hostPort}/appointment`,
        {
          json: appointment,
        }
      );
    } catch (doh) {
      chai.assert.fail();
    }
  }).timeout(3000);

  const failWithCode = async (errorMessage: string, appointment: any) => {
    try {
      await request.post(
        `http://${config.hostName}:${config.hostPort}/appointment`,
        {
          json: appointment,
        }
      );
      chai.assert.fail(
        true,
        false,
        "Request was successful when it should have failed."
      );
    } catch (doh) {
      if (doh instanceof Error && doh.message.startsWith(errorMessage)) {
        // success
      } else if (doh instanceof Error) {
        chai.assert.fail(true, false, doh.message);
      } else chai.assert.fail(true, false, doh);
    }
  };
});

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
        reject();
      }
    }, timeout);
  });
};
