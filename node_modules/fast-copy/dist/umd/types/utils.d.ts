export interface Cache {
    has: (value: any) => boolean;
    set: (key: any, value: any) => void;
    get: (key: any) => any;
}
/**
 * Error thrown when the copier traverses deeper than the configured `maxDepth`.
 *
 * @note
 * Extends `RangeError` for backwards compatibility, since exceeding the maximum depth
 * previously surfaced as a native `RangeError` from stack exhaustion.
 */
export declare class MaxDepthExceededError extends RangeError {
    readonly maxDepth: number;
    constructor(maxDepth: number);
}
declare function createCacheModern(): Cache;
/**
 * Get a new cache object to prevent circular references.
 */
export declare const createCache: typeof createCacheModern;
/**
 * Get an empty version of the object with the same prototype it has.
 */
export declare function getCleanClone(prototype: any): any;
declare function getRegExpFlagsModern(regExp: RegExp): string;
/**
 * Get the flags to apply to the copied regexp.
 */
export declare const getRegExpFlags: typeof getRegExpFlagsModern;
declare function getTagLegacy(value: any): string;
/**
 * Get the tag of the value passed, so that the correct copier can be used.
 */
export declare const getTag: typeof getTagLegacy;
export {};
