"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMemoryKV = createMemoryKV;
function createMemoryKV(initial) {
    const map = new Map(Object.entries(initial ?? {}));
    return {
        get: (key) => map.get(key),
        set: (key, value) => void map.set(key, value),
        delete: (key) => void map.delete(key),
    };
}
