/**
 * Hashly - Client-Side Key-Value Lookup System
 * 
 * Uses MPHF + Chunked File Lookup for O(1) key lookups
 */

class HashlyLookup {
    constructor() {
        this.meta = null;
        this.initialized = false;
        this.cache = new Map(); // LRU cache for chunks
        this.maxCacheSize = 10;
    }

    /**
     * Initialize the lookup system
     */
    async init() {
        try {
            console.log('🚀 Initializing Hashly...');

            // Load metadata
            await this.loadMetadata();

            this.initialized = true;
            console.log('✅ Hashly initialized successfully');

            return true;
        } catch (error) {
            console.error('❌ Initialization error:', error);
            throw error;
        }
    }

    /**
     * Load metadata about chunks
     */
    async loadMetadata() {
        try {
            const response = await fetch('meta.json');
            if (!response.ok) {
                throw new Error('Failed to load metadata');
            }
            this.meta = await response.json();
            console.log(`📊 Loaded metadata: ${this.meta.total_keys?.toLocaleString() || 'N/A'} keys, ${this.meta.total_chunks || 'N/A'} chunks`);
        } catch (error) {
            console.warn('⚠️ Metadata not found, using defaults');
            this.meta = {
                total_chunks: 2860,
                total_keys: 14300247
            };
        }
    }

    /**
     * FNV-1a 32-bit hash function
     * Must match Python implementation exactly
     */
    fnv1a_32(str) {
        let hval = 0x811c9dc5;
        const fnv_32_prime = 0x01000193;

        for (let i = 0; i < str.length; i++) {
            hval = hval ^ str.charCodeAt(i);
            hval = Math.imul(hval, fnv_32_prime);
        }

        return hval >>> 0; // Force unsigned 32-bit
    }

    /**
     * Validate key format
     */
    validateKey(key) {
        // Must be exactly 32 hex characters
        const hexPattern = /^[0-9a-f]{32}$/i;
        return hexPattern.test(key);
    }

    /**
     * Normalize key to lowercase
     */
    normalizeKey(key) {
        return key.toLowerCase().trim();
    }

    /**
     * Calculate Chunk ID using Hash Sharding
     */
    getChunkId(key) {
        const hash = this.fnv1a_32(key);
        // Chunk ID is 1-based (chunk_00001)
        // hash % total_chunks gives 0..N-1
        return (hash % this.meta.total_chunks) + 1;
    }

    /**
     * Fetch chunk file
     */
    async fetchChunk(chunkId) {
        // Check cache first
        const cacheKey = `chunk_${chunkId}`;
        if (this.cache.has(cacheKey)) {
            console.log(`💾 Cache hit for chunk ${chunkId}`);
            return this.cache.get(cacheKey);
        }

        // Fetch from server
        const filename = `chunk_${String(chunkId).padStart(5, '0')}.txt`;
        const url = `chunks/${filename}`;

        console.log(`📥 Fetching chunk: ${filename}`);

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch chunk ${chunkId}`);
        }

        const text = await response.text();

        // Add to cache (LRU)
        this.addToCache(cacheKey, text);

        return text;
    }

    /**
     * Add item to LRU cache
     */
    addToCache(key, value) {
        // Remove oldest if cache is full
        if (this.cache.size >= this.maxCacheSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }

        this.cache.set(key, value);
    }

    /**
     * Scan chunk for exact key match
     */
    scanChunk(chunkText, targetKey) {
        const lines = chunkText.split('\n');

        for (const line of lines) {
            if (!line.trim()) continue;

            const colonIndex = line.indexOf(':');
            if (colonIndex === -1) continue;

            const key = line.substring(0, colonIndex).trim();

            if (key === targetKey) {
                const value = line.substring(colonIndex + 1).trim();
                return value;
            }
        }

        return null;
    }

    /**
     * Main lookup function
     */
    async lookup(key, onProgress = null) {
        const startTime = performance.now();

        try {
            // Step 1: Validate
            if (onProgress) onProgress('Validating key...');

            if (!this.validateKey(key)) {
                throw new Error('Invalid key format. Must be 32 hexadecimal characters.');
            }

            // Step 2: Normalize
            const normalizedKey = this.normalizeKey(key);

            // Step 3: Calculate Chunk ID
            if (onProgress) onProgress('Calculating chunk ID...');

            const chunkId = this.getChunkId(normalizedKey);
            console.log(`📦 Chunk ID: ${chunkId}`);

            // Step 4: Fetch chunk
            if (onProgress) onProgress(`Loading chunk ${chunkId}...`);

            const chunkText = await this.fetchChunk(chunkId);

            // Step 5: Scan for key
            if (onProgress) onProgress('Scanning for key...');

            const value = this.scanChunk(chunkText, normalizedKey);

            const endTime = performance.now();
            const duration = Math.round(endTime - startTime);

            if (value === null) {
                throw new Error('Key not found in dataset');
            }

            console.log(`✅ Found value in ${duration}ms`);

            return {
                success: true,
                value: value,
                duration: duration,
                chunkId: chunkId,
                mphfIndex: 'N/A' // No longer applicable
            };

        } catch (error) {
            const endTime = performance.now();
            const duration = Math.round(endTime - startTime);

            console.error('❌ Lookup error:', error);

            return {
                success: false,
                error: error.message,
                duration: duration
            };
        }
    }
}

class UIController {
    constructor(lookupSystem) {
        this.lookup = lookupSystem;
        this.isSearching = false;
        this.hideTimeout = null;

        // DOM Elements
        this.searchInput = document.getElementById('searchInput');
        this.searchButton = document.getElementById('searchButton');
        this.inputIndicator = document.getElementById('inputIndicator');

        this.loadingContainer = document.getElementById('loadingContainer');
        this.loadingSteps = document.getElementById('loadingSteps');

        this.resultContainer = document.getElementById('resultContainer');
        this.resultValue = document.getElementById('resultValue');
        this.resultStats = document.getElementById('resultStats');

        this.errorContainer = document.getElementById('errorContainer');
        this.errorMessage = document.getElementById('errorMessage');

        this.copyButton = document.getElementById('copyButton');

        this.attachEventListeners();
    }

    attachEventListeners() {
        // Search button
        this.searchButton.addEventListener('click', (e) => {
            e.preventDefault();
            this.handleSearch();
        });

        // Enter key
        this.searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.handleSearch();
            }
        });

        // Input validation
        this.searchInput.addEventListener('input', (e) => {
            this.validateInput(e.target.value);
        });

        // Copy button
        this.copyButton.addEventListener('click', () => this.copyResult());
    }

    validateInput(value) {
        const isValid = /^[0-9a-f]{32}$/i.test(value);
        const isEmpty = value.length === 0;

        if (isEmpty) {
            this.inputIndicator.className = 'input-indicator';
        } else if (isValid) {
            this.inputIndicator.className = 'input-indicator valid';
        } else {
            this.inputIndicator.className = 'input-indicator invalid';
        }
    }

    async handleSearch() {
        if (this.isSearching) return;

        const key = this.searchInput.value.trim();

        if (!key) {
            this.showError('Please enter a key');
            return;
        }

        this.isSearching = true;

        // Hide previous results/errors
        this.hideAll();

        // Show loading
        this.showLoading();

        try {
            // Perform lookup
            const result = await this.lookup.lookup(key, (step) => {
                this.updateLoadingStep(step);
            });

            // Hide loading
            this.hideLoading();

            // Show result
            if (result.success) {
                this.showResult(result);
            } else {
                this.showError(result.error);
            }
        } catch (error) {
            this.hideLoading();
            this.showError('An unexpected error occurred');
            console.error(error);
        } finally {
            this.isSearching = false;
        }
    }

    showLoading() {
        if (this.hideTimeout) {
            clearTimeout(this.hideTimeout);
            this.hideTimeout = null;
        }
        this.loadingContainer.classList.remove('hidden');
        this.searchButton.disabled = true;
    }

    hideLoading() {
        this.loadingContainer.classList.add('hidden');
        this.searchButton.disabled = false;
    }

    updateLoadingStep(step) {
        this.loadingSteps.textContent = step;
    }

    showResult(result) {
        if (this.hideTimeout) {
            clearTimeout(this.hideTimeout);
            this.hideTimeout = null;
        }

        // Hide error container immediately
        this.errorContainer.classList.remove('show');
        this.errorContainer.classList.add('hidden');

        this.resultValue.textContent = result.value;
        this.resultStats.innerHTML = `
            <span>Chunk: ${result.chunkId}</span>
            <span>•</span>
            <span>Time: ${result.duration}ms</span>
            <span>•</span>
            <span>Index: ${result.mphfIndex.toLocaleString()}</span>
        `;
        this.resultContainer.classList.remove('hidden');

        // Animate in
        setTimeout(() => {
            this.resultContainer.classList.add('show');
        }, 10);
    }

    showError(message) {
        if (this.hideTimeout) {
            clearTimeout(this.hideTimeout);
            this.hideTimeout = null;
        }

        // Hide result container immediately
        this.resultContainer.classList.remove('show');
        this.resultContainer.classList.add('hidden');

        this.errorMessage.textContent = message;
        this.errorContainer.classList.remove('hidden');

        // Animate in
        setTimeout(() => {
            this.errorContainer.classList.add('show');
        }, 10);
    }

    hideAll() {
        if (this.hideTimeout) {
            clearTimeout(this.hideTimeout);
        }

        this.resultContainer.classList.remove('show');
        this.errorContainer.classList.remove('show');

        this.hideTimeout = setTimeout(() => {
            this.resultContainer.classList.add('hidden');
            this.errorContainer.classList.add('hidden');
            this.hideTimeout = null;
        }, 300);
    }

    async copyResult() {
        const value = this.resultValue.textContent;

        try {
            await navigator.clipboard.writeText(value);

            // Visual feedback
            const originalText = this.copyButton.innerHTML;
            this.copyButton.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
            `;
            this.copyButton.classList.add('copied');

            setTimeout(() => {
                this.copyButton.innerHTML = originalText;
                this.copyButton.classList.remove('copied');
            }, 2000);

        } catch (error) {
            console.error('Copy failed:', error);
        }
    }
}

// ============================================================================
// Initialize Application
// ============================================================================

let app;

async function initApp() {
    try {
        console.log('🚀 Starting Hashly...');

        // Create lookup system
        const lookupSystem = new HashlyLookup();

        // Initialize
        await lookupSystem.init();

        // Create UI controller
        app = new UIController(lookupSystem);

        console.log('✅ Application ready');

    } catch (error) {
        console.error('❌ Failed to initialize application:', error);

        // Show error to user
        const errorContainer = document.getElementById('errorContainer');
        const errorMessage = document.getElementById('errorMessage');

        if (errorContainer && errorMessage) {
            errorMessage.textContent = `Initialization failed: ${error.message}`;
            errorContainer.classList.remove('hidden');
        }
    }
}

// Start app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}
