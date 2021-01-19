import "mocha";
import { Watcher } from "../../src/watcher/watcher";
import { KitsuneInspector, KitsuneAppointment, KitsuneTools } from "../../src/integrations/kitsune";
import { ethers } from "ethers";
import Ganache from "ganache-core";
import { GasPriceEstimator, MultiResponder } from "../../src/responder";
import { ChannelType, Block } from "../../src/dataEntities";
import { AppointmentStore } from "../../src/watcher/store";
import { wait } from "../../src/utils";
import {
    BlockProcessor,
    BlockCache,
    blockFactory
} from "../../src/blockMonitor";
import levelup from "levelup";
import MemDown from "memdown";
import { BlockchainMachine } from "../../src/blockMonitor/blockchainMachine";

const ganache = Ganache.provider({
    mnemonic: "myth like bonus scare over problem client lizard pioneer submit female collect"
});

describe("End to end", () => {
    let player0: string,
        player1: string,
        pisaAccount: string,
        hashState: string,
        sig0: string,
        sig1: string,
        channelContract: ethers.Contract,
        round: number,
        provider: ethers.providers.Web3Provider = new ethers.providers.Web3Provider(ganache);

    before(async () => {
        provider.pollingInterval = 100;
        // set the 2 accounts
        const accounts = await provider.listAccounts();
        player0 = accounts[0];
        player1 = accounts[1];
        pisaAccount = accounts[2];

        // deploy the channel
        const channelContractFactory = new ethers.ContractFactory(
            KitsuneTools.ContractAbi,
            KitsuneTools.ContractBytecode,
            provider.getSigner(accounts[3])
        );
        channelContract = await channelContractFactory.deploy([player0, player1], 11);
        // set the round
        round = 1;
        // set the hash state
        hashState = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("hello"));
        // set the sigs
        const setStateHash = KitsuneTools.hashForSetState(hashState, round, channelContract.address);
        sig0 = await provider.getSigner(player0).signMessage(ethers.utils.arrayify(setStateHash));
        sig1 = await provider.getSigner(player1).signMessage(ethers.utils.arrayify(setStateHash));
    });

    it("inspect and watch a contract", async () => {
        const inspector = new KitsuneInspector(10, provider);
        // 1. Verify appointment
        const appointment = new KitsuneAppointment({
            stateUpdate: {
                contractAddress: channelContract.address,
                hashState: hashState,
                round: 1,
                signatures: [sig0, sig1]
            },

            expiryPeriod: 12,
            type: ChannelType.Kitsune
        });
        await inspector.inspectAndPass(appointment);

        const blockCache = new BlockCache<Block>(200);
        const blockProcessor = new BlockProcessor<Block>(provider, blockFactory, blockCache);
        await blockProcessor.start();

        // 2. pass this appointment to the watcher
        const gasPriceEstimator = new GasPriceEstimator(provider, blockProcessor.blockCache);

        const multiResponder = new MultiResponder(provider.getSigner(pisaAccount), gasPriceEstimator);

        let db = levelup(MemDown());
        const store = new AppointmentStore(
            db,
            new Map([[ChannelType.Kitsune, (obj: any) => new KitsuneAppointment(obj)]])
        );
        await store.start();
        await store.addOrUpdateByStateLocator(appointment);
        const watcher = new Watcher(multiResponder, blockProcessor.blockCache, store, 0, 20);
        const player0Contract = channelContract.connect(provider.getSigner(player0));

        const blockchainMachine = new BlockchainMachine<Block>(blockProcessor);

        blockchainMachine.addComponent(watcher);
        await blockchainMachine.start();
        await multiResponder.start();

        // 3. Trigger a dispute
        const tx = await player0Contract.triggerDispute();
        await tx.wait();

        await blockchainMachine.stop();
        await multiResponder.stop();
        await store.stop();
        await blockProcessor.stop();
        await db.close();
        await wait(2000);
    }).timeout(3000);
});
