/**
 * MPHF Evaluator for Browser
 */

class MPHFEvaluator {
    constructor() {
        this.lookupTable = null;
        this.loaded = false;
        this.debugMode = false;
    }
    
    async load() {
        try {
            // Try to load debug mapping first (for verification without WASM)
            try {
                const response = await fetch('mphf/mphf_debug.json');
                if (response.ok) {
                    this.lookupTable = await response.json();
                    this.debugMode = true;
                    console.log('[WARN] Using DEBUG MPHF mapping');
                    this.loaded = true;
                    return true;
                }
            } catch (e) {
                // Ignore
            }

            console.log('[WARN] Using demo MPHF evaluator - replace with WASM for production');
            this.loaded = true;
            return true;
        } catch (error) {
            console.error('Error loading MPHF:', error);
            return false;
        }
    }
    
    lookup(key) {
        if (!this.loaded) {
            throw new Error('MPHF not loaded - call load() first');
        }
        
        if (this.debugMode && this.lookupTable) {
            return this.lookupTable[key];
        }
        
        // DEMO: Simple hash function
        return this.simpleHash(key);
    }
    
    simpleHash(key) {
        let hash = 0;
        for (let i = 0; i < key.length; i++) {
            const char = key.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = MPHFEvaluator;
}
