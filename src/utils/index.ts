import { TimeoutError } from "../dataEntities";
import { EventEmitter } from "events";

export { validateProvider, getJsonRPCProvider } from "./ethers";

/**
 * Returns a Promise that resolves after waiting `milliseconds`.
 * @param milliseconds
 */
export const wait = (milliseconds: number) => {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
};

/**
 * A promise that can be canceled to release any resource.
 * Instances of this class should guarantee that all resources will eventually be released if `cancel()` is called,
 * regardless of wether the Promise is fulfilled or rejected.
 *
 * Once `cancel()` is called, the behaviour of the promise is undefined, and the caller
 * should not expect it to reject or fulfill, nor to be pending forever.
 *
 * Promises generated by calling `then` on a CancellablePromise are `not` CancellablePromise, but normal Promises instead.
 * Thus, a reference to the original promise should be kept and it is the one that should be cancelled.
 */
export class CancellablePromise<T> extends Promise<T> {
    constructor(
        executor: (resolve: (value?: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void,
        private canceller?: () => void
    ) {
        super(executor);
    }

    /**
     * If a canceller was provided in the constructor, it calls it. Then it sets `cancelled` to true.
     */
    public cancel() {
        this.canceller && this.canceller();
    }
}

// generalizes the events interface of both the EventEmitter and ethers.providers.BaseProvider
interface EventEmitterLike<TEvent> {
    once(event: TEvent, listener: (...args: any) => void): EventEmitterLike<TEvent>;
    removeListener(event: TEvent, listener: (...args: any) => void): EventEmitterLike<TEvent>;
}

/**
 * Returns a CancellablePromise that resolves as soon as an event is fired for the first time.
 * It resolves to the array arguments of the event handler's call.
 **/
export function waitForEvent<T>(emitter: EventEmitterLike<T>, event: T): CancellablePromise<any[]> {
    const cancellerInfo: { handler?: () => void } = {};

    const canceller = () => emitter.removeListener(event, cancellerInfo.handler!);

    return new CancellablePromise<any[]>(resolve => {
        const handler = (...args: any[]) => resolve(args);
        cancellerInfo.handler = handler;
        emitter.once(event, handler);
    }, canceller);
}

/**
 * Returns a `CancellablePromise` that resolves or rejects as soon as any of `promises` resolves or reject, and then cancels
 * all the `cancellables`. Cancelling the returned promise also cancels all the `cancellables`.
 * @param promises
 * @param cancellables
 */
export function cancellablePromiseRace(
    promises: Iterable<Promise<any>>,
    cancellables: Iterable<CancellablePromise<any>>
) {
    const canceller = () => {
        for (const p of cancellables) p.cancel();
    };
    return new CancellablePromise((resolve, reject) => {
        Promise.race(promises)
            .then(resolve)
            .catch(reason => reject(reason))
            .finally(canceller);
    }, canceller);
}

/**
 * Wraps `promise` in a new promise that rejects with a `TimeoutError` after waiting `milliseconds` if `promise` is still pending.
 *
 * @param promise the original promise
 * @param milliseconds the amount of milliseconds before the returned promise is rejected
 */
export function promiseTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => {
            setTimeout(() => {
                reject(new TimeoutError("Timed out in " + milliseconds + "ms."));
            }, milliseconds);
        })
    ]);
}

/**
 * Returns `word` if `val` is 1, `plural` otherwise.
 *
 * @param val the number to be tested
 * @param word the string to be used as singular
 * @param [plural] the string to be used as plural; defaults to `word + 's'`.
 */
export function plural(val: number, word: string, plural: string = word + "s") {
    return val == 1 ? word : plural;
}