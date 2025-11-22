(() => {
'use strict';

// ========================================
// PETOK PREDICT - CLEAN & SIMPLE
// ========================================

// Config will be loaded from Netlify Functions (secure)
let CONFIG = null;
let configLoaded = false;

let supabaseClient = null;
let googleAuthReady = false;
let googleButtonRendered = false;
let captchaWidgetId = null;
const ensuredProfiles = new Set();
const scriptLoadingPromises = {};

function loadScript(src) {
    if (scriptLoadingPromises[src]) {
        return scriptLoadingPromises[src];
    }

    if (document.querySelector(`script[src="${src}"]`)) {
        return Promise.resolve();
    }

    const promise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = resolve;
        script.onerror = (e) => {
            delete scriptLoadingPromises[src];
            reject(e);
        };
        document.head.appendChild(script);
    });

    scriptLoadingPromises[src] = promise;
    return promise;
}

// Load config from Netlify Function
async function loadConfig() {
    if (configLoaded) return CONFIG;
    
    try {
        const response = await fetch('/api/config');
        if (!response.ok) throw new Error('Failed to load config');
        CONFIG = await response.json();
        configLoaded = true;
        return CONFIG;
    } catch (error) {
        console.error('Config load failed:', error);
        alert('Gagal memuat konfigurasi aplikasi. Silakan refresh halaman.');
        throw error;
    }
}

let supabaseLoadingPromise = null;
async function ensureSupabase() {
    if (supabaseClient) return supabaseClient;
    if (!CONFIG) await loadConfig();
    
    if (!window.supabase) {
        if (!supabaseLoadingPromise) {
            supabaseLoadingPromise = loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');
        }
        await supabaseLoadingPromise;

        // Wait for supabase global
        let attempts = 0;
        while (!window.supabase && attempts < 50) {
            await new Promise(r => setTimeout(r, 50));
            attempts++;
        }
        if (!window.supabase) throw new Error('Supabase SDK failed to load');
    }
    
    if (!supabaseClient) {
        supabaseClient = supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);
    }
    return supabaseClient;
}

// Getter for Supabase client
async function getSb() {
    return ensureSupabase();
}

function deriveUserIdentity(user) {
    if (!user) {
        return { fullName: '', email: '', picture: null };
    }

    const metadata = user.user_metadata || {};
    const nameCandidates = [
        metadata.full_name,
        metadata.name,
        `${metadata.given_name || ''} ${metadata.family_name || ''}`.trim(),
        user.email ? user.email.split('@')[0] : ''
    ].filter(Boolean);

    const picture = metadata.avatar_url
        || metadata.picture
        || metadata.image
        || metadata.avatar
        || null;

    return {
        fullName: nameCandidates[0] || '',
        email: user.email || '',
        picture
    };
}

function escapeAttr(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

async function ensureProfileRow(user) {
    if (!user || ensuredProfiles.has(user.id)) {
        return;
    }

    const sb = await getSb();
    const identity = deriveUserIdentity(user);

    try {
        const payload = {
            id: user.id,
            email: user.email || null,
            full_name: identity.fullName || null,
            avatar_url: identity.picture || null
        };

        const { error } = await sb
            .from('profiles')
            .upsert(payload, { onConflict: 'id' });

        if (error) throw error;
        ensuredProfiles.add(user.id);
    } catch (error) {
        console.warn('Ensure profile failed', error);
    }
}

// ========================================
// GOOGLE AUTH
// ========================================

async function initGoogleAuth() {
    await loadConfig();
    
    if (!CONFIG || CONFIG.googleClientId.includes('YOUR_')) return;

    const loginContainer = document.getElementById('login-btn');
    if (!loginContainer) return;

    if (!window.google?.accounts?.id) {
        try {
            await loadScript('https://accounts.google.com/gsi/client');
        } catch (e) {
            console.error('Failed to load Google Sign-In', e);
            return;
        }
    }

    // Wait for Google GSI to be ready
    let attempts = 0;
    while (!window.google?.accounts?.id && attempts < 50) {
        await new Promise(r => setTimeout(r, 100));
        attempts++;
    }

    if (!window.google?.accounts?.id) {
        console.error('Google Sign-In failed to initialize');
        return;
    }

    const setup = () => {
        if (googleAuthReady || !window.google?.accounts?.id) return;
        googleAuthReady = true;

        google.accounts.id.initialize({
            client_id: CONFIG.googleClientId,
            callback: async (response) => {
                try {
                    const sb = await getSb();
                    const { error } = await sb.auth.signInWithIdToken({
                        provider: 'google',
                        token: response.credential
                    });
                    if (error) throw error;
                    await updateAuthUI();
                    try {
                        window.chickenCalcInstance?.closeModal();
                    } catch (_) {
                        document.getElementById('petokModal')?.remove();
                    }
                } catch (e) {
                    alert('Login gagal: ' + e.message);
                }
            },
            cancel_on_tap_outside: false
        });

        // Render Google button only once
        if (!googleButtonRendered) {
            google.accounts.id.renderButton(
                loginContainer,
                {
                    theme: 'outline',
                    size: 'large',
                    text: 'signin',
                    logo_alignment: 'left',
                    shape: 'pill'
                }
            );
            googleButtonRendered = true;
        }
    };

    setup();
}

async function logout() {
    const cachedUser = (() => {
        try {
            return JSON.parse(localStorage.getItem('pp_user') || 'null');
        } catch (_) {
            return null;
        }
    })();

    try {
        applyAuthState(null);
        const sb = await getSb();
        const { error } = await sb.auth.signOut();
        if (error) throw error;

        if (window.google?.accounts?.id) {
            const revokeFn = google.accounts.id.revoke;
            if (cachedUser?.email && typeof revokeFn === 'function') {
                revokeFn(cachedUser.email, () => {});
            } else {
                google.accounts.id.disableAutoSelect();
            }
        }
    } catch (e) {
        console.error('Logout failed', e);
        alert('Logout gagal: ' + (e?.message || 'Tidak diketahui'));
    } finally {
        updateAuthUI();
    }
}

function applyAuthState(session) {
    const loginContainer = document.getElementById('login-btn');
    const userBox = document.getElementById('user-box');
    const userName = document.getElementById('user-name');
    const userAvatar = document.getElementById('user-avatar');
    // Buttons are now always visible, but gated by checkAuth()

    if (session?.user) {
        const identity = deriveUserIdentity(session.user);
        if (loginContainer) loginContainer.style.display = 'none';
        if (userBox) userBox.style.display = 'flex';
        if (userName) userName.textContent = identity.fullName || session.user.email;
        if (userAvatar) {
            if (identity.picture) {
                userAvatar.src = identity.picture;
                userAvatar.alt = identity.fullName || session.user.email || 'Foto Profil';
                userAvatar.style.display = 'block';
                if (userBox) userBox.classList.add('has-avatar');
            } else {
                userAvatar.removeAttribute('src');
                userAvatar.style.display = 'none';
                if (userBox) userBox.classList.remove('has-avatar');
            }
        }
        localStorage.setItem('pp_user', JSON.stringify({
            id: session.user.id,
            email: session.user.email,
            name: identity.fullName || session.user.email,
            avatar: identity.picture || null
        }));
    } else {
        if (loginContainer) {
            loginContainer.style.display = 'flex';
            // Re-render button on logout only if not already rendered
            if (googleAuthReady && window.google?.accounts?.id && !googleButtonRendered) {
                loginContainer.innerHTML = '';
                google.accounts.id.renderButton(
                    loginContainer,
                    {
                        theme: 'outline',
                        size: 'large',
                        text: 'signin',
                        logo_alignment: 'left',
                        shape: 'pill'
                    }
                );
                googleButtonRendered = true;
            }
        }
        if (userBox) userBox.style.display = 'none';
        if (userAvatar) {
            userAvatar.removeAttribute('src');
            userAvatar.style.display = 'none';
        }
        if (userBox) userBox.classList.remove('has-avatar');
        // Buttons remain visible
        localStorage.removeItem('pp_user');
        
        // Force disable advanced mode on logout
        if (window.chickenCalcInstance) {
            window.chickenCalcInstance.toggleAdvancedMode(false, { skipConfigurator: true, skipAdvice: true });
        }
    }

    if (document.body && !document.body.classList.contains('auth-ready')) {
        document.body.classList.add('auth-ready');
    }
}async function updateAuthUI(sessionOverride) {
    if (sessionOverride !== undefined) {
        applyAuthState(sessionOverride);
        if (sessionOverride?.user) {
            await ensureProfileRow(sessionOverride.user);
        }
        return;
    }
    const sb = await getSb();
    const { data: { session } } = await sb.auth.getSession();
    applyAuthState(session);
    if (session?.user) {
        await ensureProfileRow(session.user);
    }
}

// ========================================
// CALCULATOR
// ========================================

class ChickenCalc {
    constructor() {
        this.price = null;
        this.assumptions = {
            pop: 100,
            survival: 0.95,
            weight: 1.0,
            feed: 400000,
            fcr: 2.3,
            doc: 8000
        };
        this.advanced = this.loadAdvancedSettings();
        this.profileLoading = false;
        this.activeTab = 'asumsi';
        this.aiGenCount = 0;
        this.ui = {};
        this.updatePending = false;
        this.init();
    }

    checkAuth() {
        const user = JSON.parse(localStorage.getItem('pp_user') || 'null');
        if (user) return true;
        this.showLoginModal();
        return false;
    }

    showLoginModal() {
        const html = `
            <div style="text-align:center;padding:20px">
                <p style="margin-bottom:20px;color:#24412F;font-weight:500">Fitur ini khusus untuk pengguna terdaftar.</p>
                <div id="modal-login-btn" style="display:flex;justify-content:center;min-height:44px"></div>
                <p style="margin-top:16px;font-size:0.9rem;color:#567a60">Silakan login dengan Google untuk melanjutkan.</p>
            </div>
        `;
        this.modal('Login Diperlukan', html);
        
        setTimeout(() => {
            if (window.google?.accounts?.id) {
                google.accounts.id.renderButton(
                    document.getElementById('modal-login-btn'),
                    {
                        theme: 'outline',
                        size: 'large',
                        text: 'signin_with',
                        shape: 'pill',
                        logo_alignment: 'left'
                    }
                );
            }
        }, 100);
    }

    async promptCaptchaAsync(title = 'Verifikasi Keamanan') {
        await loadConfig();

        return new Promise(async (resolve) => {
            if (!window.hcaptcha) {
                try {
                    await loadScript('https://js.hcaptcha.com/1/api.js?render=explicit');
                } catch (e) {
                    console.error('Failed to load hCaptcha', e);
                    this.notify('Gagal memuat sistem keamanan', 'error');
                    return;
                }
            }

            // Wait for hcaptcha to be ready
            let attempts = 0;
            while (!window.hcaptcha && attempts < 50) {
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }

            if (!window.hcaptcha) {
                this.notify('Sistem keamanan tidak siap', 'error');
                return;
            }

            const html = `
                <div id="captchaStep" style="text-align:center">
                    <p style="color:#567a60;margin-bottom:16px">Mohon verifikasi bahwa Anda bukan robot:</p>
                    <div id="hcaptcha-container-generic"></div>
                </div>
            `;
            this.modal(title, html);
            
            window.onGenericCaptchaSuccess = (token) => {
                this.closeModal();
                resolve(token);
            };

            try {
                window.hcaptcha.render('hcaptcha-container-generic', {
                    sitekey: CONFIG?.captchaKey || '',
                    callback: 'onGenericCaptchaSuccess'
                });
            } catch (e) {
                console.error('hCaptcha render error:', e);
                this.notify('Gagal menampilkan captcha', 'error');
            }
        });
    }

    init() {
        this.cacheDOM();
        this.bind();
        // Defer chart initialization to unblock main thread
        if ('requestIdleCallback' in window) {
            requestIdleCallback(() => this.initChart());
        } else {
            setTimeout(() => this.initChart(), 100);
        }
        this.applyAdvancedState();
        this.fetchPrice('kampung');
    }

    cacheDOM() {
        const ids = [
            'statJenis', 'statHarga', 'centerRevenue', 'detailProfit', 
            'detailFeed', 'detailDOC', 'detailOther', 'detailTotalCost',
            'statEkorPanen', 'statHarvestEstimate', 'statFCRDisplay',
            'statCostPerKg', 'statBreakEven', 'statEpef',
            'tabSimulasiContent', 'simCards', 'marketEditRow', 'inputMarketPrice',
            'valPopulasi', 'valSurvival', 'valBobot', 'valHargaPakan', 'valFCR', 'valDocPrice'
        ];
        ids.forEach(id => {
            this.ui[id] = document.getElementById(id);
        });
    }

    scheduleUpdate() {
        if (this.updatePending) return;
        this.updatePending = true;
        requestAnimationFrame(() => {
            this.calc();
            if (this.ui.tabSimulasiContent?.classList.contains('active')) {
                this.renderSim();
            }
            this.updatePending = false;
        });
    }

    loadAdvancedSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem('pp_advanced') || 'null');
            if (saved && typeof saved === 'object') {
                return {
                    enabled: !!saved.enabled,
                    basis: saved.basis || 'live',
                    dressing: saved.dressing ?? 0.72,
                    processCost: saved.processCost ?? 1500,
                    harvestAge: saved.harvestAge ?? 35,
                    wastagePct: saved.wastagePct ?? 0.03,
                    shrinkagePct: saved.shrinkagePct ?? 0.02,
                    laborCost: saved.laborCost ?? 300000,
                    overheadCost: saved.overheadCost ?? 200000,
                    transportCost: saved.transportCost ?? 150000,
                    heatingCost: saved.heatingCost ?? 0,
                    vaccineCost: saved.vaccineCost ?? 100000,
                    electricityCost: saved.electricityCost ?? 0,
                    notes: saved.notes || '',
                    custom: saved.custom || {
                        length: null,
                        width: null,
                        height: null,
                        ventilation: null,
                        extras: []
                    },
                    adviceMeta: saved.adviceMeta || {
                        lastSync: null,
                        snapshot: null
                    }
                };
            }
        } catch (e) {
            console.warn('Failed to load advanced settings', e);
        }
        return {
            enabled: false,
            basis: 'live',
            dressing: 0.72,
            processCost: 1500,
            harvestAge: 35,
            wastagePct: 0.03,
            shrinkagePct: 0.02,
            laborCost: 300000,
            overheadCost: 200000,
            transportCost: 150000,
            heatingCost: 0,
            vaccineCost: 100000,
            electricityCost: 0,
            notes: '',
            custom: {
                length: null,
                width: null,
                height: null,
                ventilation: null,
                extras: []
            },
            adviceMeta: {
                lastSync: null,
                snapshot: null
            }
        };
    }

    persistAdvancedSettings() {
        localStorage.setItem('pp_advanced', JSON.stringify(this.advanced));
    }

    applyAdvancedState() {
        const stats = document.getElementById('advancedStats');
        const banner = document.getElementById('advancedBanner');
        const controls = document.getElementById('advancedControls');
        const toggleRow = document.getElementById('advancedToggleRow');
        if (stats) stats.style.display = this.advanced.enabled ? 'grid' : 'none';
        if (banner) banner.style.display = this.advanced.enabled ? 'block' : 'none';
        if (controls) controls.style.display = this.advanced.enabled ? 'grid' : 'none';
        if (toggleRow) toggleRow.style.display = 'flex';
        if (!this.advanced.enabled) {
            this.setText('statCostPerKg', '–');
            this.setText('statBreakEven', '–');
            const epefEl = document.getElementById('statEpef');
            if (epefEl) epefEl.textContent = '–';
        }
        this.syncAdvancedToggleUI();
        this.syncAdvancedControls();
    }

    syncAdvancedControls() {
        if (!this.advanced) return;
        const byId = (id) => document.getElementById(id);

        const setSlider = (sliderId, displayId, value, formatter) => {
            const slider = byId(sliderId);
            const display = byId(displayId);
            if (slider) slider.value = value;
            if (display) display.textContent = typeof formatter === 'function' ? formatter(value) : value;
        };

        const formatCurrency = (val) => this.fmt(val);
        const formatPercent = (val) => `${(val * 100).toFixed(1)}%`;

        // Basis buttons visibility
        const basisSwitch = document.querySelectorAll('#basisSwitch .basis-btn');
        basisSwitch.forEach(btn => {
            btn?.classList.toggle('active', btn.dataset.basis === this.advanced.basis);
        });

        document.querySelectorAll('.advanced-only').forEach(el => {
            const basis = el.getAttribute('data-basis');
            if (!basis) return;
            el.style.display = this.advanced.enabled && basis === this.advanced.basis ? '' : 'none';
        });

        if (!this.advanced.enabled) {
            return;
        }

        setSlider('rangeHarvestAge', 'valHarvestAge', this.advanced.harvestAge, (v) => v);
        setSlider('rangeWastage', 'valWastage', this.advanced.wastagePct * 100, (v) => `${Number(v).toFixed(1)}%`);
        setSlider('rangeShrinkage', 'valShrinkage', this.advanced.shrinkagePct * 100, (v) => `${Number(v).toFixed(1)}%`);
        setSlider('rangeLaborCost', 'valLaborCost', this.advanced.laborCost, formatCurrency);
        setSlider('rangeOverheadCost', 'valOverheadCost', this.advanced.overheadCost, formatCurrency);
        setSlider('rangeTransportCost', 'valTransportCost', this.advanced.transportCost, formatCurrency);
        setSlider('rangeHeatingCost', 'valHeatingCost', this.advanced.heatingCost, formatCurrency);
        setSlider('rangeVaccineCost', 'valVaccineCost', this.advanced.vaccineCost, formatCurrency);
        setSlider('rangeDressing', 'valDressing', Math.round(this.advanced.dressing * 100), (v) => `${v}`);
        setSlider('rangeProcessCost', 'valProcessCost', this.advanced.processCost, formatCurrency);

        const wastageSlider = byId('rangeWastage');
        if (wastageSlider) wastageSlider.value = this.advanced.wastagePct * 100;
        const shrinkageSlider = byId('rangeShrinkage');
        if (shrinkageSlider) shrinkageSlider.value = this.advanced.shrinkagePct * 100;

        const notes = byId('advancedNotes');
        if (notes) notes.value = this.advanced.notes || '';
    }

    syncAdvancedToggleUI() {
        const mainSwitch = document.getElementById('advancedModeSwitch');
        if (mainSwitch) {
            const isOn = !!this.advanced?.enabled;
            mainSwitch.classList.toggle('active', isOn);
            mainSwitch.setAttribute('aria-pressed', isOn ? 'true' : 'false');
        }
    }

    toggleAdvancedMode(forceValue, opts = {}) {
        if (forceValue === undefined && !this.checkAuth()) {
            return this.advanced.enabled;
        }

        const nextState = typeof forceValue === 'boolean' ? forceValue : !this.advanced.enabled;
        if (this.advanced.enabled === nextState) {
            this.syncAdvancedToggleUI();
            return nextState;
        }

        this.advanced.enabled = nextState;
        this.persistAdvancedSettings();
        this.applyAdvancedState();
        this.calc();
        if (document.getElementById('tabSimulasiContent')?.classList.contains('active')) {
            this.renderSim();
        }

        if (nextState) {
            const missingDimensions = !this.advanced.custom || !this.advanced.custom.length || !this.advanced.custom.width;
            const needsConfig = !this.advanced.adviceMeta?.lastSync || missingDimensions;
            if (needsConfig && !opts.skipConfigurator) {
                setTimeout(() => this.openAdvancedConfigurator(true), 120);
            }
            if (!this.advanced.adviceMeta?.lastSync && !opts.skipAdvice) {
                setTimeout(() => this.generateAdvancedAdvice(), 200);
            }
        }

        return nextState;
    }

    bind() {
        const chickenSelect = document.getElementById('chickenType');
        const chickenButtons = document.querySelectorAll('#chickenTabs .tab-btn');

        if (chickenSelect) {
            chickenSelect.addEventListener('change', (e) => {
                const value = e.target.value;
                this.updateChickenToggle(value);
                this.syncDefaults(value);
                this.fetchPrice(value);
            });
        }

        chickenButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                if (!chickenSelect) return;
                const value = btn.dataset.type;
                if (!value || chickenSelect.value === value) return;
                chickenSelect.value = value;
                chickenSelect.dispatchEvent(new Event('change'));
            });
        });

        this.updateChickenToggle(chickenSelect?.value || 'kampung');

        // Login button will be handled by Google renderButton
        document.getElementById('logout-btn')?.addEventListener('click', logout);
        document.querySelectorAll('.profile-trigger').forEach(el => {
            el.addEventListener('click', () => this.showProfile());
            el.addEventListener('keydown', evt => {
                if (evt.key === 'Enter' || evt.key === ' ') {
                    evt.preventDefault();
                    this.showProfile();
                }
            });
        });
        document.getElementById('saveCalculation')?.addEventListener('click', () => this.save());
        document.getElementById('viewHistory')?.addEventListener('click', () => this.showHistory());
        document.getElementById('exportPdfDashboard')?.addEventListener('click', () => this.exportPDF());
        const mainAdvancedSwitch = document.getElementById('advancedModeSwitch');
        if (mainAdvancedSwitch) {
            const toggle = () => this.toggleAdvancedMode();
            mainAdvancedSwitch.addEventListener('click', toggle);
            mainAdvancedSwitch.addEventListener('keydown', (evt) => {
                if (evt.key === 'Enter' || evt.key === ' ') {
                    evt.preventDefault();
                    toggle();
                }
            });
        }
        // Tabs: Asumsi / Simulasi
        const asumsiTabBtn = document.getElementById('tabAsumsi');
        const simulasiTabBtn = document.getElementById('tabSimulasi');
        asumsiTabBtn?.addEventListener('click', () => this.tab('asumsi'));
        simulasiTabBtn?.addEventListener('click', () => this.tab('simulasi'));
        if (asumsiTabBtn) asumsiTabBtn.setAttribute('aria-pressed', this.activeTab === 'asumsi' ? 'true' : 'false');
        if (simulasiTabBtn) simulasiTabBtn.setAttribute('aria-pressed', this.activeTab === 'simulasi' ? 'true' : 'false');

        // Market Edit
        const btnEditMarket = document.getElementById('btnEditMarket');
        const marketEditRow = document.getElementById('marketEditRow');
        const btnApplyMarket = document.getElementById('btnApplyMarket');
        const inputMarketPrice = document.getElementById('inputMarketPrice');

        if (btnEditMarket && marketEditRow) {
            btnEditMarket.addEventListener('click', () => {
                const isHidden = marketEditRow.style.display === 'none';
                marketEditRow.style.display = isHidden ? 'grid' : 'none';
                if (isHidden && inputMarketPrice) {
                    inputMarketPrice.focus();
                    if (this.price?.price) inputMarketPrice.value = this.price.price;
                }
            });
        }

        if (btnApplyMarket && inputMarketPrice) {
            btnApplyMarket.addEventListener('click', () => {
                const val = Number(inputMarketPrice.value);
                if (val > 0) {
                    this.price = { price: val, source: 'Manual Input' };
                    this.calc();
                    if (document.getElementById('tabSimulasiContent')?.classList.contains('active')) {
                        this.renderSim();
                    }
                    if (marketEditRow) marketEditRow.style.display = 'none';
                }
            });
        }

        this.bindSliders();
        this.bindAdvancedControls();
    }

    updateChickenToggle(value) {
        document.querySelectorAll('#chickenTabs .tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.type === value);
        });
    }

    bindAdvancedControls() {
        const basisButtons = document.querySelectorAll('#basisSwitch .basis-btn');
        basisButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const basis = btn.dataset.basis;
                if (!basis || this.advanced.basis === basis) return;
                this.advanced.basis = basis;
                this.persistAdvancedSettings();
                this.applyAdvancedState();
                this.calc();
                if (document.getElementById('tabSimulasiContent')?.classList.contains('active')) {
                    this.renderSim();
                }
            });
        });

        const sliderMap = [
            { id: 'rangeHarvestAge', prop: 'harvestAge', fmt: (v) => Number(v), displayId: 'valHarvestAge', customDisplay: (raw) => `${raw}` },
            { id: 'rangeWastage', prop: 'wastagePct', fmt: (v) => Number(v) / 100, displayId: 'valWastage', customDisplay: (raw) => `${Number(raw).toFixed(1)}%` },
            { id: 'rangeShrinkage', prop: 'shrinkagePct', fmt: (v) => Number(v) / 100, displayId: 'valShrinkage', customDisplay: (raw) => `${Number(raw).toFixed(1)}%` },
            { id: 'rangeLaborCost', prop: 'laborCost', fmt: (v) => Number(v), displayId: 'valLaborCost' },
            { id: 'rangeOverheadCost', prop: 'overheadCost', fmt: (v) => Number(v), displayId: 'valOverheadCost' },
            { id: 'rangeTransportCost', prop: 'transportCost', fmt: (v) => Number(v), displayId: 'valTransportCost' },
            { id: 'rangeHeatingCost', prop: 'heatingCost', fmt: (v) => Number(v), displayId: 'valHeatingCost' },
            { id: 'rangeVaccineCost', prop: 'vaccineCost', fmt: (v) => Number(v), displayId: 'valVaccineCost' },
            { id: 'rangeDressing', prop: 'dressing', fmt: (v) => Number(v) / 100, displayId: 'valDressing', customDisplay: (raw) => `${Math.round(Number(raw))}` },
            { id: 'rangeProcessCost', prop: 'processCost', fmt: (v) => Number(v), displayId: 'valProcessCost' }
        ];

        sliderMap.forEach(cfg => {
            const el = document.getElementById(cfg.id);
            if (!el) return;
            el.addEventListener('input', (e) => {
                const raw = e.target.value;
                this.advanced[cfg.prop] = cfg.fmt(raw);
                const display = cfg.displayId ? document.getElementById(cfg.displayId) : null;
                if (display) {
                    if (typeof cfg.customDisplay === 'function') {
                        display.textContent = cfg.customDisplay(raw);
                    } else {
                        display.textContent = this.fmt(Number(raw));
                    }
                }

                this.persistAdvancedSettings();
                this.scheduleUpdate();
            });
        });

        const advConfigBtn = document.getElementById('openAdvancedConfigurator');
        if (advConfigBtn) {
            advConfigBtn.addEventListener('click', () => {
                if (!this.advanced.enabled) {
                    this.toggleAdvancedMode(true, { skipConfigurator: true, skipAdvice: true });
                    setTimeout(() => this.openAdvancedConfigurator(true), 140);
                } else {
                    this.openAdvancedConfigurator(false);
                }
            });
        }

        document.getElementById('regenAdvice')?.addEventListener('click', () => {
            if (!this.advanced.enabled) {
                this.toggleAdvancedMode(true, { skipConfigurator: true });
                return;
            }
            this.generateAdvancedAdvice();
        });
    }

    async generateAdvancedAdvice() {
        if (!this.advanced.enabled) {
            this.notify('Aktifkan mode advance dulu', 'info');
            return;
        }

        this.aiGenCount = (this.aiGenCount || 0) + 1;
        if (this.aiGenCount % 3 === 0) {
            await this.promptCaptchaAsync();
        }

        const button = document.getElementById('regenAdvice');
        if (button) {
            button.disabled = true;
            button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="simple-icon" viewBox="0 0 24 24"><path d="M4.5 3h15M4.5 21h15M6 3v4.5c0 2.5 2 4.5 4.5 4.5h3c2.5 0 4.5-2 4.5-4.5V3M6 21v-4.5c0-2.5 2-4.5 4.5-4.5h3c2.5 0 4.5 2 4.5 4.5V21"></path></svg> Menghitung...';
        }

        try {
            const payload = {
                action: 'advanced-advice',
                context: {
                    farmSize: 'custom',
                    population: this.assumptions.pop,
                    chickenType: document.getElementById('chickenType')?.value || 'kampung',
                    coop: this.advanced.custom || {},
                    location: this.advanced.location || {},
                    customNeeds: this.advanced.custom?.extras || []
                }
            };

            const res = await fetch('/api/proxy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                throw new Error(`Status ${res.status}`);
            }

            const data = await res.json();
            this.hydrateAdvancedFromAdvice(data);
            this.persistAdvancedSettings();
            this.syncAdvancedControls();
            this.calc();
            if (document.getElementById('tabSimulasiContent')?.classList.contains('active')) {
                this.renderSim();
            }
            this.notify('Rekomendasi diperbarui', 'success');
        } catch (error) {
            console.error('Advice error', error);
            this.notify('Gagal mendapatkan rekomendasi', 'error');
        } finally {
            if (button) {
                button.disabled = false;
                button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="simple-icon" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg> Regenerasi rekomendasi';
            }
        }
    }

    hydrateAdvancedFromAdvice(data) {
        if (!data || typeof data !== 'object') return;

        const asNumber = (val, fallback) => {
            const num = Number(val);
            return Number.isFinite(num) ? num : fallback;
        };

        if (data.harvest_age_days) {
            this.advanced.harvestAge = asNumber(data.harvest_age_days, this.advanced.harvestAge);
        }

        if (data.dressing_pct !== undefined) {
            const val = data.dressing_pct > 1 ? data.dressing_pct / 100 : data.dressing_pct;
            this.advanced.dressing = Math.min(Math.max(val, 0.45), 0.9);
        }

        if (data.process_cost_idr !== undefined) {
            this.advanced.processCost = Math.max(0, asNumber(data.process_cost_idr, this.advanced.processCost));
        }

        if (data.wastage_pct !== undefined) {
            const val = data.wastage_pct > 1 ? data.wastage_pct / 100 : data.wastage_pct;
            this.advanced.wastagePct = Math.min(Math.max(val, 0), 0.15);
        }

        if (data.shrinkage_pct !== undefined) {
            const val = data.shrinkage_pct > 1 ? data.shrinkage_pct / 100 : data.shrinkage_pct;
            this.advanced.shrinkagePct = Math.min(Math.max(val, 0), 0.15);
        }

        if (data.basis === 'carcass' || data.basis === 'live') {
            this.advanced.basis = data.basis;
        }

        let energyTotal = this.advanced.heatingCost || 0;

        if (data.heating) {
            if (data.heating.estimated_cost_idr !== undefined) {
                const heatingSuggested = Math.max(0, asNumber(data.heating.estimated_cost_idr, this.advanced.heatingCost));
                energyTotal = heatingSuggested;
            }
            this.advanced.adviceMeta = {
                ...this.advanced.adviceMeta,
                heating: {
                    bulbs: data.heating.bulbs ?? null,
                    wattPerBulb: data.heating.watt_per_bulb ?? null,
                    hoursPerDay: data.heating.hours_per_day ?? null,
                    days: data.heating.days ?? null,
                    otherDevices: data.heating.other_devices || []
                }
            };
        }

        if (data.electricity?.cost_idr !== undefined) {
            energyTotal += Math.max(0, asNumber(data.electricity.cost_idr, 0));
            this.advanced.adviceMeta = {
                ...this.advanced.adviceMeta,
                electricity: {
                    kwh: data.electricity.kwh ?? null,
                    cost: asNumber(data.electricity.cost_idr, 0)
                }
            };
        }

        this.advanced.heatingCost = energyTotal;
        this.advanced.electricityCost = 0;

        if (data.vaccines) {
            if (data.vaccines.total_cost_idr !== undefined) {
                this.advanced.vaccineCost = Math.max(0, asNumber(data.vaccines.total_cost_idr, this.advanced.vaccineCost));
            }
            this.advanced.adviceMeta = {
                ...this.advanced.adviceMeta,
                vaccines: data.vaccines.items || []
            };
        }

        if (data.labor_cost_idr !== undefined) {
            this.advanced.laborCost = Math.max(0, asNumber(data.labor_cost_idr, this.advanced.laborCost));
        }

        if (data.overhead_cost_idr !== undefined) {
            this.advanced.overheadCost = Math.max(0, asNumber(data.overhead_cost_idr, this.advanced.overheadCost));
        }

        if (data.transport_cost_idr !== undefined) {
            this.advanced.transportCost = Math.max(0, asNumber(data.transport_cost_idr, this.advanced.transportCost));
        }

        const noteSections = [];
        if (Array.isArray(this.advanced.adviceMeta?.vaccines) && this.advanced.adviceMeta.vaccines.length) {
            const schedule = this.advanced.adviceMeta.vaccines
                .map(item => `• Hari ${item.day ?? '?'}: ${item.name || 'Vaksin'} (${item.dose || 'dosis'})`)
                .join('\n');
            noteSections.push('Jadwal vaksin:\n' + schedule);
        }
        if (this.advanced.adviceMeta?.heating) {
            const h = this.advanced.adviceMeta.heating;
            const line = `Pemanas: ${h.bulbs || '?'} bohlam @${h.wattPerBulb || '?'}W, ${h.hoursPerDay || '?'} jam/hari selama ${h.days || '?'} hari.`;
            noteSections.push(line);
            if (Array.isArray(h.otherDevices) && h.otherDevices.length) {
                noteSections.push('Perangkat tambahan: ' + h.otherDevices.join(', '));
            }
        }
        if (data.notes) {
            noteSections.push(data.notes);
        }
        this.advanced.notes = noteSections.join('\n\n');
        this.advanced.adviceMeta = {
            ...this.advanced.adviceMeta,
            lastSync: new Date().toISOString(),
            snapshot: data
        };

        const notes = document.getElementById('advancedNotes');
        if (notes) {
            notes.value = this.advanced.notes;
        }
    }

    bindSliders() {
        const sliders = [
            { id: 'rangePopulasi', k: 'pop', d: 'valPopulasi', f: v => v },
            { id: 'rangeSurvival', k: 'survival', d: 'valSurvival', f: v => v, s: 100 },
            { id: 'rangeBobot', k: 'weight', d: 'valBobot', f: v => v.toFixed(2) },
            { id: 'rangeHargaPakan', k: 'feed', d: 'valHargaPakan', f: v => this.fmt(v) },
            { id: 'rangeFCR', k: 'fcr', d: 'valFCR', f: v => v.toFixed(2) },
            { id: 'rangeDocPrice', k: 'doc', d: 'valDocPrice', f: v => this.fmt(v) }
        ];

        sliders.forEach(sl => {
            const el = document.getElementById(sl.id);
            if (!el) return;
            el.addEventListener('input', e => {
                const val = +e.target.value;
                this.assumptions[sl.k] = sl.s ? val / sl.s : val;
                const disp = this.ui[sl.d] || document.getElementById(sl.d);
                if (disp) disp.textContent = sl.f(sl.s ? val : val);
                this.scheduleUpdate();
            });
        });
    }

    syncDefaults(type) {
        const isBroiler = type === 'broiler';
        this.assumptions.fcr = isBroiler ? 1.7 : 2.3;
        this.assumptions.weight = isBroiler ? 1.10 : 1.00;
        this.assumptions.survival = isBroiler ? 0.96 : 0.95;
        this.assumptions.doc = isBroiler ? 6000 : 8000;
        
        this.setSlider('rangeFCR', 'valFCR', this.assumptions.fcr, v => v.toFixed(2));
        this.setSlider('rangeBobot', 'valBobot', this.assumptions.weight, v => v.toFixed(2));
        this.setSlider('rangeSurvival', 'valSurvival', this.assumptions.survival * 100, v => v);
        this.setSlider('rangeDocPrice', 'valDocPrice', this.assumptions.doc, v => this.fmt(v));
    }

    setSlider(sId, dId, val, fmt) {
        const s = document.getElementById(sId);
        const d = document.getElementById(dId);
        if (s) s.value = val;
        if (d) d.textContent = fmt(val);
    }

    async fetchPrice(type) {
        try {
            const endpoints = {
                kampung: '/api/proxy?source=pasarsegar&product=ayam-kampung',
                broiler: '/api/proxy?source=japfabest&product=ayam-broiler'
            };
            const res = await fetch(endpoints[type]);
            const data = await res.json();
            this.price = data;
            this.calc();
            if (document.getElementById('tabSimulasiContent')?.classList.contains('active')) {
                this.renderSim();
            }
        } catch (e) {
            this.price = null;
            const h = document.getElementById('statHarga');
            if (h) h.textContent = 'Error';
            if (document.getElementById('tabSimulasiContent')?.classList.contains('active')) {
                this.renderSim();
            }
        }
    }

    computeEconomics(overrides = {}, options = {}) {
        const chickenType = (options.chickenType || document.getElementById('chickenType')?.value || 'kampung').toLowerCase();
        const isBroiler = chickenType === 'broiler';
        const base = this.assumptions;

        const pop = Math.max(1, Math.round(overrides.pop ?? base.pop));
        const survivalRaw = overrides.survival ?? base.survival;
        const survival = Math.min(Math.max(Number(survivalRaw) || 0, 0), 1);
        const weight = Number(overrides.weight ?? base.weight) || 1;
        const feedPrice = Math.max(1, Math.round(overrides.feed ?? base.feed));
        const fcr = Number(overrides.fcr ?? base.fcr) || 2.0;
        const docPrice = Math.max(0, Math.round(overrides.doc ?? base.doc));

        const priceInput = options.price ?? (typeof this.price?.price === 'number' ? this.price.price : null);
        const priceValid = typeof priceInput === 'number' && priceInput > 0;

        // Biological estimation of harvest age based on FCR & Weight (Refined by Expert)
        // Broiler: 20 + (Weight * 8) + ((FCR - 1.6) * 4)
        // Kampung: 45 + (Weight * 30) + ((FCR - 2.8) * 5)
        const bioAge = isBroiler 
            ? 20 + (weight * 8) + ((fcr - 1.6) * 4)
            : 45 + (weight * 30) + ((fcr - 2.8) * 5);
        const predictedHarvestAge = Math.max(20, Math.round(bioAge));

        const advancedActive = !!this.advanced?.enabled;
        const wastagePct = advancedActive
            ? Math.max(0, Number(this.advanced.wastagePct ?? 0))
            : (isBroiler ? 0.05 : 0);
        const shrinkagePct = advancedActive ? Math.max(0, Number(this.advanced.shrinkagePct ?? 0)) : 0;
        const shrinkageFactor = Math.max(0, 1 - shrinkagePct);
        
        // Use advanced setting if active, otherwise use predicted biological age
        const harvestAge = advancedActive
            ? Math.max(1, Math.round(this.advanced.harvestAge || predictedHarvestAge))
            : predictedHarvestAge;

        const basis = advancedActive && this.advanced.basis === 'carcass' ? 'carcass' : 'live';
        const dressing = basis === 'carcass'
            ? Math.min(Math.max(Number(this.advanced.dressing ?? 0.72), 0.45), 0.9)
            : 0.72;
        const processCost = basis === 'carcass' ? Math.max(0, Math.round(this.advanced.processCost ?? 0)) : 0;

        const harvest = Math.round(pop * survival);
        const feedKgPrice = feedPrice / 50;
        const feedCostPerBird = feedKgPrice * (1 + wastagePct) * fcr * weight;
        const feedCostPerBirdRounded = Math.round(feedCostPerBird);
        const totalFeedCost = Math.round(pop * feedCostPerBirdRounded);
        const docCost = Math.round(pop * docPrice);

        const vac = Math.ceil(pop / 100) * 100000;
        const vit = Math.ceil(pop / 100) * 50000;
        const baseVacCost = vac + vit;
        const elec = Math.round(Math.ceil(pop / 100) * 10 * 504 / 1000 * 1444.70);
        const baseEnergyCost = elec;

        const ratio = options.scaleAgainstPop ? Math.max(pop / options.scaleAgainstPop, 0.1) : 1;
        const scaled = (value, minFactor = 0.5) => Math.round(value * Math.max(ratio, minFactor));

        const vaccineCost = advancedActive
            ? scaled(Number(this.advanced.vaccineCost ?? baseVacCost), 0.5)
            : baseVacCost;
        const energyCost = advancedActive
            ? scaled(Number(this.advanced.heatingCost ?? baseEnergyCost), 0.6)
            : baseEnergyCost;
        const laborCost = advancedActive
            ? scaled(Number(this.advanced.laborCost ?? 0), 0.5)
            : 0;
        const overheadCost = advancedActive
            ? scaled(Number(this.advanced.overheadCost ?? 0), 0.4)
            : 0;
        const transportCost = advancedActive
            ? scaled(Number(this.advanced.transportCost ?? 0), 0.7)
            : 0;

        const extraCost = advancedActive
            ? vaccineCost + energyCost + laborCost + overheadCost + transportCost
            : baseVacCost + baseEnergyCost;

        const totalCost = docCost + totalFeedCost + extraCost;

        let revenue = null;
        let carcassKg = null;
        if (priceValid) {
            if (basis === 'carcass') {
                carcassKg = harvest * weight * dressing;
                revenue = Math.max(0, Math.round(carcassKg * priceInput - harvest * processCost));
            } else {
                const liveKg = harvest * weight * shrinkageFactor;
                carcassKg = liveKg;
                revenue = Math.max(0, Math.round(liveKg * priceInput));
            }
        }

        const profit = revenue != null ? revenue - totalCost : null;
        const margin = revenue && revenue > 0 ? profit / revenue : null;
        const productionKg = carcassKg && carcassKg > 0 ? carcassKg : null;
        const costPerKg = productionKg ? totalCost / productionKg : null;
        const breakEven = productionKg ? totalCost / productionKg : null;
        const epef = (survival * 100 * weight * 100) / (fcr * harvestAge);

        return {
            chickenType,
            pop,
            survival,
            weight,
            feedPrice,
            fcr,
            docPrice,
            harvest,
            feedCostPerBird: feedCostPerBirdRounded,
            totalFeedCost,
            docCost,
            vaccineCost,
            energyCost,
            laborCost,
            overheadCost,
            transportCost,
            extraCost,
            totalCost,
            price: priceValid ? priceInput : null,
            priceValid,
            revenue,
            profit,
            margin,
            basis,
            dressing,
            processCost,
            wastagePct,
            shrinkagePct,
            shrinkageFactor,
            harvestAge,
            predictedHarvestAge,
            costPerKg,
            breakEven,
            epef,
            advancedActive,
            productionKg,
            carcassKg,
            notes: this.advanced?.notes || ''
        };
    }

    calc() {
        const result = this.computeEconomics();
        const jenisDisplay = result.chickenType === 'broiler' ? 'Broiler' : 'Ayam Kampung';
        const priceLabel = result.priceValid
            ? `${this.fmt(result.price)}/${result.basis === 'carcass' ? 'kg karkas' : 'kg hidup'}`
            : 'Menunggu harga';

        this.setText('statJenis', jenisDisplay);
        this.setText('statHarga', priceLabel);

        // New Dashboard Updates
        this.updateChart(result);
        this.setText('centerRevenue', result.revenue != null ? this.fmt(result.revenue) : 'Rp 0');
        this.setText('detailProfit', result.profit != null ? this.fmt(result.profit) : 'Rp 0');
        this.setText('detailFeed', this.fmt(result.totalFeedCost));
        this.setText('detailDOC', this.fmt(result.docCost));
        this.setText('detailOther', this.fmt(result.extraCost));
        this.setText('detailTotalCost', this.fmt(result.totalCost));

        this.setText('statEkorPanen', `${result.harvest.toLocaleString('id-ID')} ekor`);
        this.setText('statHarvestEstimate', `${result.predictedHarvestAge} hari`);
        this.setText('statFCRDisplay', result.fcr.toFixed(2));

        this.updateChart(result);

        if (result.advancedActive) {
            this.setText('statCostPerKg', result.costPerKg ? this.fmt(result.costPerKg) : '–');
            this.setText('statBreakEven', result.breakEven ? this.fmt(result.breakEven) : '–');
            const epefEl = document.getElementById('statEpef');
            if (epefEl) {
                epefEl.textContent = Number.isFinite(result.epef) ? result.epef.toFixed(1) : '–';
            }
        }
    }

    async initChart() {
        if (this.chart) return;
        
        const ctx = document.getElementById('financialChart');
        if (!ctx) return;

        if (!window.Chart) {
            try {
                await loadScript('https://cdn.jsdelivr.net/npm/chart.js');
            } catch (e) {
                console.error('Failed to load Chart.js', e);
                return;
            }
        }

        // Register Chart.js defaults if needed, though usually global defaults work
        if (window.Chart) {
            Chart.defaults.font.family = "'Plus Jakarta Sans', sans-serif";
            Chart.defaults.color = '#567A60';
        }

        this.chart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Keuntungan', 'Pakan', 'DOC', 'Lainnya'],
                datasets: [{
                    data: [0, 0, 0, 0],
                    backgroundColor: [
                        '#3F8F5F', // Profit
                        '#E08A3D', // Feed
                        '#D4A373', // DOC
                        '#89AD92'  // Other
                    ],
                    borderWidth: 0,
                    hoverOffset: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '75%',
                layout: {
                    padding: 20
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (context) => {
                                if (context.parsed !== null) {
                                    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(context.parsed);
                                }
                                return '';
                            }
                        }
                    }
                }
            }
        });
    }

    async updateChart(result) {
        if (!this.chart) {
            if (!this.chartLoadingPromise) {
                this.chartLoadingPromise = this.initChart();
            }
            await this.chartLoadingPromise;
        }
        if (!this.chart) return;

        const profit = Math.max(0, result.profit || 0);
        const feed = result.totalFeedCost || 0;
        const doc = result.docCost || 0;
        const other = result.extraCost || 0;

        this.chart.data.datasets[0].data = [profit, feed, doc, other];
        this.chart.update();
    }

    tab(t) {
        const next = t === 'simulasi' ? 'simulasi' : 'asumsi';
        if (next === this.activeTab) {
            return;
        }

        const prev = this.activeTab;
        const prevBtn = document.getElementById(prev === 'asumsi' ? 'tabAsumsi' : 'tabSimulasi');
        const nextBtn = document.getElementById(next === 'asumsi' ? 'tabAsumsi' : 'tabSimulasi');
        const prevContent = document.getElementById(prev === 'asumsi' ? 'tabAsumsiContent' : 'tabSimulasiContent');
        const nextContent = document.getElementById(next === 'asumsi' ? 'tabAsumsiContent' : 'tabSimulasiContent');

        if (prevBtn) {
            prevBtn.classList.remove('active');
            prevBtn.setAttribute('aria-pressed', 'false');
        }
        if (nextBtn) {
            nextBtn.classList.add('active');
            nextBtn.setAttribute('aria-pressed', 'true');
        }

        if (nextContent) {
            nextContent.classList.remove('is-leaving');
            nextContent.classList.add('active');
        }

        if (prevContent && prevContent !== nextContent) {
            prevContent.classList.add('is-leaving');
            prevContent.classList.remove('active');
            prevContent.addEventListener('animationend', () => {
                prevContent.classList.remove('is-leaving');
            }, { once: true });
        }

        this.activeTab = next;

        const title = document.getElementById('secondaryCardTitle');
        if (title) title.textContent = next === 'asumsi' ? 'Asumsi Produksi' : 'Simulasi Skenario';
        if (next === 'simulasi') {
            this.renderSim();
        }
    }

    renderSim() {
        const c = document.getElementById('simCards');
        if (!c) return;

        const base = {
            pop: this.assumptions.pop,
            survival: this.assumptions.survival,
            doc: this.assumptions.doc,
            feed: this.assumptions.feed,
            fcr: this.assumptions.fcr,
            weight: this.assumptions.weight
        };

        const scenarios = [
            {
                name: 'Optimis',
                note: 'Input turun, bobot naik, FCR lebih efisien.',
                overrides: {
                    pop: Math.round(base.pop * 1.05),
                    survival: Math.min(1, base.survival + 0.03),
                    doc: Math.round(base.doc * 0.94),
                    feed: Math.round(base.feed * 0.96),
                    fcr: Math.max(1.5, Number((base.fcr * 0.95).toFixed(2))),
                    weight: Number((base.weight + 0.05).toFixed(2))
                }
            },
            {
                name: 'Realistis',
                note: 'Menggunakan asumsi dasar saat ini.',
                overrides: {
                    pop: base.pop,
                    survival: base.survival,
                    doc: base.doc,
                    feed: base.feed,
                    fcr: base.fcr,
                    weight: base.weight
                }
            },
            {
                name: 'Konservatif',
                note: 'Survival turun, pakan lebih mahal, bobot terkikis.',
                overrides: {
                    pop: Math.max(50, Math.round(base.pop * 0.92)),
                    survival: Math.max(0.7, base.survival - 0.05),
                    doc: Math.round(base.doc * 1.08),
                    feed: Math.round(base.feed * 1.07),
                    fcr: Math.min(3.2, Number((base.fcr * 1.08).toFixed(2))),
                    weight: Math.max(0.8, Number((base.weight - 0.05).toFixed(2)))
                }
            }
        ];

    const fmtCurrency = (value) => Number.isFinite(value) ? this.fmt(Math.round(value)) : '—';

        let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px">';
        scenarios.forEach(({ name, note, overrides }) => {
            const result = this.calcScenario(overrides);
            const iconUp = '<svg xmlns="http://www.w3.org/2000/svg" class="simple-icon" viewBox="0 0 24 24"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline><polyline points="17 6 23 6 23 12"></polyline></svg>';
            const iconDown = '<svg xmlns="http://www.w3.org/2000/svg" class="simple-icon" viewBox="0 0 24 24"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"></polyline><polyline points="17 18 23 18 23 12"></polyline></svg>';
            const icon = result.profit == null ? '—' : (result.profit > 0 ? iconUp : iconDown);
            const col = result.profit == null ? '#567A60' : (result.profit > 0 ? '#3F8F5F' : '#C8513A');
            const costPerBird = result.harvest > 0 ? Math.round(result.totalCost / result.harvest) : null;
            const marginLabel = result.margin != null ? `${(result.margin * 100).toFixed(1)}%` : '—';
            html += `
                <div style="background:rgba(255,255,254,0.95);padding:20px;border-radius:12px;border:1px solid rgba(137,173,146,0.4);box-shadow:0 18px 32px rgba(41,71,54,0.2);color:#24412F;display:flex;flex-direction:column;gap:10px">
                    <div>
                        <h4 style="margin:0 0 4px">${name}</h4>
                        <small style="color:#567A60">${note}</small>
                    </div>
                    <div style="font-size:0.9rem;display:grid;gap:6px">
                        <div><b>Populasi:</b> ${overrides.pop.toLocaleString('id-ID')} ekor</div>
        <div><b>Survival:</b> ${(overrides.survival * 100).toFixed(1)}% • <b>Bobot:</b> ${Number(overrides.weight).toFixed(2)} kg</div>
                        <div><b>FCR:</b> ${Number(overrides.fcr).toFixed(2)} • <b>Panen:</b> ${result.harvest.toLocaleString('id-ID')} ekor</div>
                    </div>
                    <hr style="margin:4px 0 8px">
                    <div style="display:grid;gap:6px;font-size:0.9rem">
                        <div><b>Total Biaya:</b> ${fmtCurrency(result.totalCost)}</div>
                        <div><b>Biaya/Ekor:</b> ${fmtCurrency(costPerBird)}</div>
                        <div><b>Break-even:</b> ${fmtCurrency(result.breakEven)}</div>
                        <div><b>Basis Harga:</b> ${result.basis === 'carcass' ? 'Karkas' : 'Bobot hidup'}</div>
                        <div><b>Pendapatan:</b> ${fmtCurrency(result.revenue)}</div>
                        <div style="font-weight:700;color:${col};display:flex;align-items:center;gap:6px"><b>Profit:</b> ${icon} ${fmtCurrency(result.profit)}</div>
                        <div><b>Margin:</b> ${marginLabel}</div>
                    </div>
                </div>
            `;
        });
        html += '</div>';
        c.innerHTML = html;
    }

    calcScenario(overrides) {
        return this.computeEconomics(overrides, {
            price: typeof this.price?.price === 'number' ? this.price.price : null,
            scaleAgainstPop: this.assumptions.pop,
            chickenType: document.getElementById('chickenType')?.value || 'kampung'
        });
    }

    async save() {
        if (!this.checkAuth()) return;

        // Show captcha modal
        await this.showCaptchaModal();
    }

    async showCaptchaModal() {
        await loadConfig();

        if (!window.hcaptcha) {
            try {
                await loadScript('https://js.hcaptcha.com/1/api.js?render=explicit');
            } catch (e) {
                console.error('Failed to load hCaptcha', e);
                this.notify('Gagal memuat sistem keamanan', 'error');
                return;
            }
        }

        // Wait for hcaptcha
        let attempts = 0;
        while (!window.hcaptcha && attempts < 50) {
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }

        if (!window.hcaptcha) {
            this.notify('Sistem keamanan tidak siap', 'error');
            return;
        }

        const html = `
            <div id="captchaStep" style="text-align:center">
                <p class="helper-text" style="margin-bottom:16px">Verifikasi dulu ya:</p>
                <div id="hcaptcha-container"></div>
            </div>
            <div id="notesStep" style="display:none">
                <p class="helper-success" style="margin-bottom:12px;display:flex;align-items:center;justify-content:center;gap:6px">
                    <svg xmlns="http://www.w3.org/2000/svg" class="simple-icon" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg> 
                    Verifikasi berhasil!
                </p>
                <div class="input-group">
                    <label>Catatan (opsional):</label>
                    <textarea id="notesInput" class="advanced-notes" placeholder="Tambahkan catatan untuk perhitungan ini..."></textarea>
                </div>
                <div style="display:flex;gap:12px;margin-top:20px;justify-content:flex-end">
                    <button id="cancelSave" class="btn-action ghost">Batal</button>
                    <button id="confirmSave" class="btn-action accent">Simpan</button>
                </div>
            </div>
        `;
        this.modal('Simpan Perhitungan', html);
        
        // Render captcha after modal is in DOM
        try {
            const container = document.getElementById('hcaptcha-container');
            if (container) {
                captchaWidgetId = window.hcaptcha.render('hcaptcha-container', {
                    sitekey: CONFIG?.captchaKey || '',
                    callback: 'onCaptchaSuccess'
                });
            }
        } catch (e) {
            console.error('hCaptcha render error:', e);
            this.notify('Gagal menampilkan captcha', 'error');
        }
    }

    async saveWithCaptcha(token) {
        // Hide captcha, show notes input
        const captchaStep = document.getElementById('captchaStep');
        const notesStep = document.getElementById('notesStep');
        
        if (captchaStep) captchaStep.style.display = 'none';
        if (notesStep) {
            notesStep.style.display = 'block';
            document.getElementById('notesInput')?.focus();
        }

        // Bind buttons
        document.getElementById('cancelSave')?.addEventListener('click', () => {
            this.closeModal();
        });

        document.getElementById('confirmSave')?.addEventListener('click', async () => {
            const notes = document.getElementById('notesInput')?.value || null;
            
            try {
                const data = this.getData();
                if (!data.marketPrice || data.marketPrice <= 0) {
                    throw new Error('Harga pasar belum tersedia. Coba lagi setelah harga ter-update.');
                }
                const sb = await getSb();
                const { data: { user } } = await sb.auth.getUser();
                await ensureProfileRow(user);
                const { error } = await sb.rpc('save_calculation', {
                    p_chicken_type: data.chickenType,
                    p_populasi: data.populasi,
                    p_survival_rate: data.survival,
                    p_bobot_panen: data.bobot,
                    p_harga_pakan_sak: data.hargaPakan,
                    p_fcr: data.fcr,
                    p_doc_price: data.docPrice,
                    p_market_price: data.marketPrice,
                    p_ekor_panen: data.ekorPanen,
                    p_total_biaya_doc: data.biayaDoc,
                    p_total_biaya_pakan: data.biayaPakan,
                    p_total_biaya_tambahan: data.biayaTambahan,
                    p_total_biaya: data.totalBiaya,
                    p_total_pendapatan: data.totalPendapatan,
                    p_keuntungan_bersih: data.keuntungan,
                    p_market_price_source: data.priceSource || null,
                    p_notes: notes,
                    p_is_advanced: data.isAdvanced,
                    p_basis: data.basis,
                    p_dressing_pct: data.dressing,
                    p_process_cost: data.processCost,
                    p_wastage_pct: data.wastagePct,
                    p_shrinkage_pct: data.shrinkagePct,
                    p_harvest_age: data.harvestAge,
                    p_vaccine_cost: data.biayaVaksin,
                    p_heating_cost: data.biayaEnergi,
                    p_labor_cost: data.biayaLabor,
                    p_overhead_cost: data.biayaOverhead,
                    p_transport_cost: data.biayaTransport,
                    p_cost_per_kg: data.costPerKg,
                    p_break_even_price: data.breakEven,
                    p_epef: data.epef,
                    p_ai_notes: data.notes,
                    p_ai_snapshot: data.aiSnapshot
                });
                if (error) throw error;
                this.closeModal();
                this.notify('Saved!', 'success');
            } catch (e) {
                this.closeModal();
                this.notify('Error: ' + e.message, 'error');
            }
        });
    }

    getData() {
        const result = this.computeEconomics();
        const marketPrice = result.priceValid ? result.price : (this.price?.price || 0);
        const aiSnapshot = this.advanced?.adviceMeta?.snapshot || null;
        const totalPendapatan = Number.isFinite(result.revenue) ? Math.round(result.revenue) : 0;
        const keuntungan = Number.isFinite(result.profit) ? Math.round(result.profit) : 0;

        return {
            chickenType: result.chickenType,
            populasi: result.pop,
            survival: result.survival,
            bobot: result.weight,
            hargaPakan: result.feedPrice,
            fcr: result.fcr,
            docPrice: result.docPrice,
            marketPrice,
            priceValid: result.priceValid,
            priceSource: this.price?.source || null,
            ekorPanen: result.harvest,
            biayaDoc: result.docCost,
            biayaPakan: result.totalFeedCost,
            biayaTambahan: result.extraCost,
            biayaVaksin: result.vaccineCost,
            biayaEnergi: result.energyCost,
            biayaLabor: result.laborCost,
            biayaOverhead: result.overheadCost,
            biayaTransport: result.transportCost,
            totalBiaya: result.totalCost,
            totalPendapatan,
            keuntungan,
            margin: result.margin,
            isAdvanced: result.advancedActive,
            basis: result.basis,
            dressing: result.dressing,
            processCost: result.processCost,
            wastagePct: result.wastagePct,
            shrinkagePct: result.shrinkagePct,
            harvestAge: result.harvestAge,
            costPerKg: result.costPerKg,
            breakEven: result.breakEven,
            epef: result.epef,
            notes: result.notes || null,
            aiSnapshot
        };
    }

    async showHistory() {
        if (!this.checkAuth()) return;

        const loadingHtml = `
            <div style="text-align:center;padding:40px;color:#567a60">
                <div style="display:inline-block;width:40px;height:40px;border:4px solid rgba(137,173,146,0.42);border-top-color:#3F8F5F;border-radius:50%;animation:spin 0.8s linear infinite"></div>
                <p style="margin-top:16px">Memuat history...</p>
            </div>
        `;
        
        this.modal('History', loadingHtml);

        try {
            const sb = await getSb();
            const { data: history, error } = await sb.rpc('get_recent_calculations', {
                limit_count: 20,
                offset_count: 0
            });
            if (error) throw error;
            
            if (!history || history.length === 0) {
                const modalBody = document.querySelector('.petok-modal-body');
                if (modalBody) {
                    modalBody.innerHTML = '<p style="text-align:center;padding:40px;color:#567a60">Belum ada history</p>';
                }
                return;
            }

            // Sort: Favorites first, then by date
            history.sort((a, b) => {
                if (a.is_favorite === b.is_favorite) {
                    return new Date(b.calculation_date) - new Date(a.calculation_date);
                }
                return a.is_favorite ? -1 : 1;
            });

            let html = '<div style="max-height:400px;overflow-y:auto">';
            history.forEach(c => {
                const date = new Date(c.calculation_date).toLocaleDateString('id-ID');
                const iconUp = '<svg xmlns="http://www.w3.org/2000/svg" class="simple-icon" viewBox="0 0 24 24"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline><polyline points="17 6 23 6 23 12"></polyline></svg>';
                const iconDown = '<svg xmlns="http://www.w3.org/2000/svg" class="simple-icon" viewBox="0 0 24 24"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"></polyline><polyline points="17 18 23 18 23 12"></polyline></svg>';
                const icon = c.keuntungan_bersih > 0 ? iconUp : iconDown;
                const col = c.keuntungan_bersih > 0 ? '#3F8F5F' : '#C8513A';
                
                // Fix: Use style="color:inherit" to ensure it takes the button's red color
                const heartOutline = '<svg xmlns="http://www.w3.org/2000/svg" class="simple-icon" style="color:inherit; fill:none; stroke:currentColor" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>';
                const heartFilled = '<svg xmlns="http://www.w3.org/2000/svg" class="simple-icon" style="color:inherit; fill:currentColor; stroke:currentColor" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>';
                const heart = c.is_favorite ? heartFilled : heartOutline;
                
                const modeBadge = c.is_advanced ? '<span class="history-tag">Advance</span>' : '';
                const basisInfo = c.is_advanced && c.basis ? ` • Basis ${c.basis === 'carcass' ? 'karkas' : 'hidup'}` : '';
                
                html += `
                    <div style="border:1px solid rgba(137,173,146,0.36);border-radius:8px;padding:12px;margin-bottom:8px;background:rgba(255,255,254,0.9)">
                        <div style="display:flex;justify-content:space-between;align-items:flex-start">
                            <div style="flex:1">
                                <div style="font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                                    <span>${c.chicken_type} - ${c.populasi} ekor</span>
                                    ${modeBadge}
                                    <button class="btn-fav" data-id="${c.id}" style="background:none;border:none;cursor:pointer;color:${c.is_favorite ? '#1e88e5' : '#567a60'};padding:4px;display:flex;align-items:center;justify-content:center">${heart}</button>
                                </div>
                                <div style="font-size:0.85rem;color:#567a60;margin-top:4px">${date}${basisInfo}</div>
                                <div style="font-weight:600;color:${col};display:flex;align-items:center;gap:6px;margin-top:4px">${icon} ${this.fmt(c.keuntungan_bersih)}</div>
                                ${c.notes ? `<div style="font-style:italic;color:#567a60;font-size:0.85rem;margin-top:4px">"${c.notes}"</div>` : ''}
                            </div>
                            <div style="display:flex;flex-direction:column;gap:8px;margin-left:12px">
                                <button class="btn-action accent btn-load" data-id="${c.id}" style="padding:4px 10px;font-size:0.8rem">Muat</button>
                                <button class="btn-action ghost btn-del" data-id="${c.id}" style="padding:4px 10px;font-size:0.8rem;color:#C8513A;background:rgba(200,81,58,0.1)">Hapus</button>
                            </div>
                        </div>
                    </div>
                `;
            });
            html += '</div>';
            
            const modalBody = document.querySelector('.petok-modal-body');
            if (modalBody) {
                modalBody.innerHTML = html;
            }
            this.bindHistoryBtns();
        } catch (e) {
            console.error('History load error', e);
            const modalBody = document.querySelector('.petok-modal-body');
            if (modalBody) {
                modalBody.innerHTML = '<p style="text-align:center;color:#C8513A;padding:40px">Gagal memuat history</p>';
            }
        }
    }

    bindHistoryBtns() {
        document.querySelectorAll('.btn-fav').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const target = e.currentTarget;
                const id = target.dataset.id;
                const sb = await getSb();
                const { data: newStatus, error } = await sb.rpc('toggle_favorite_calculation', {
                    calculation_id: id
                });
                if (error) {
                    console.error('Toggle favorite error:', error);
                    return;
                }
                const heartOutline = '<svg xmlns="http://www.w3.org/2000/svg" class="simple-icon" style="color:inherit; fill:none; stroke:currentColor" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>';
                const heartFilled = '<svg xmlns="http://www.w3.org/2000/svg" class="simple-icon" style="color:inherit; fill:currentColor; stroke:currentColor" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>';
                target.innerHTML = newStatus ? heartFilled : heartOutline;
                target.style.color = newStatus ? '#1e88e5' : '#567a60';
            });
        });

        document.querySelectorAll('.btn-load').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.currentTarget?.dataset?.id;
                const sb = await getSb();
                const { data: calc, error } = await sb
                    .from('calculation_history')
                    .select('*')
                    .eq('id', id)
                    .single();
                if (error) {
                    console.error('Load calculation error:', error);
                    return;
                }
                if (calc) {
                    this.loadCalc(calc);
                    this.closeModal();
                    this.notify('Loaded', 'success');
                }
            });
        });

        document.querySelectorAll('.btn-del').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                if (!confirm('Hapus?')) return;
                const id = e.currentTarget?.dataset?.id;
                const sb = await getSb();
                const { error } = await sb.rpc('delete_calculation', {
                    calculation_id: id
                });
                if (error) {
                    console.error('Delete calculation error:', error);
                    this.notify('Error', 'error');
                    return;
                }
                e.currentTarget.closest('div[style*="border:1px"]').remove();
                this.notify('Deleted', 'success');
            });
        });
    }

    loadCalc(c) {
        const select = document.getElementById('chickenType');
        if (select) select.value = c.chicken_type;
        this.updateChickenToggle(c.chicken_type);
        this.assumptions = {
            pop: c.populasi,
            survival: c.survival_rate,
            weight: c.bobot_panen,
            feed: c.harga_pakan_sak,
            fcr: c.fcr,
            doc: c.doc_price
        };

        this.setSlider('rangePopulasi', 'valPopulasi', c.populasi, v => v);
        this.setSlider('rangeSurvival', 'valSurvival', c.survival_rate * 100, v => v);
        this.setSlider('rangeBobot', 'valBobot', c.bobot_panen, v => v.toFixed(2));
        this.setSlider('rangeHargaPakan', 'valHargaPakan', c.harga_pakan_sak, v => this.fmt(v));
        this.setSlider('rangeFCR', 'valFCR', c.fcr, v => v.toFixed(2));
        this.setSlider('rangeDocPrice', 'valDocPrice', c.doc_price, v => this.fmt(v));

        if (typeof c.is_advanced === 'boolean') {
            this.toggleAdvancedMode(c.is_advanced, { skipConfigurator: true, skipAdvice: true });
        }
        if (c.is_advanced) {
            this.advanced.basis = c.basis || this.advanced.basis;
            if (c.dressing_pct != null) this.advanced.dressing = c.dressing_pct;
            if (c.process_cost != null) this.advanced.processCost = c.process_cost;
            if (c.wastage_pct != null) this.advanced.wastagePct = c.wastage_pct;
            if (c.shrinkage_pct != null) this.advanced.shrinkagePct = c.shrinkage_pct;
            if (c.harvest_age != null) this.advanced.harvestAge = c.harvest_age;
            if (c.vaccine_cost != null) this.advanced.vaccineCost = c.vaccine_cost;
            if (c.heating_cost != null) this.advanced.heatingCost = c.heating_cost;
            if (c.labor_cost != null) this.advanced.laborCost = c.labor_cost;
            if (c.overhead_cost != null) this.advanced.overheadCost = c.overhead_cost;
            if (c.transport_cost != null) this.advanced.transportCost = c.transport_cost;
            if (c.ai_notes) this.advanced.notes = c.ai_notes;
            this.persistAdvancedSettings();
            this.applyAdvancedState();
        }

        this.calc();
    }

    async showProfile() {
        if (!this.checkAuth()) return;

        if (this.profileLoading) {
            return;
        }

        this.profileLoading = true;

        const loadingHtml = `
            <div style="text-align:center;padding:40px;color:#567a60">
                <div style="display:inline-block;width:40px;height:40px;border:4px solid rgba(137,173,146,0.42);border-top-color:#3F8F5F;border-radius:50%;animation:spin 0.8s linear infinite"></div>
                <p style="margin-top:16px">Memuat profil...</p>
            </div>
        `;
        
        this.modal('Profile', loadingHtml);

        try {
            const sb = await getSb();
            const { data: { user } } = await sb.auth.getUser();
            if (!user) throw new Error('Not authenticated');

            const identity = deriveUserIdentity(user);

            const { data: profile, error } = await sb
                .from('profiles')
                .select('*')
                .eq('id', user.id)
                .maybeSingle();
            
            if (error) throw error;
            const p = profile || {};
            const displayName = p.full_name ?? identity.fullName ?? '';
            const displayPhone = p.phone ?? '';
            const displayFarmName = p.farm_name ?? '';
            if (typeof p.advanced_mode === 'boolean') {
                this.advanced.enabled = p.advanced_mode;
            }
            if (p.advanced_config && typeof p.advanced_config === 'object') {
                const cfg = p.advanced_config;
                const mapKeys = ['basis','dressing','processCost','harvestAge','wastagePct','shrinkagePct','laborCost','overheadCost','transportCost','heatingCost','vaccineCost','notes'];
                mapKeys.forEach(key => {
                    if (cfg[key] !== undefined && cfg[key] !== null) {
                        this.advanced[key] = cfg[key];
                    }
                });
                if (cfg.custom && typeof cfg.custom === 'object') {
                    this.advanced.custom = {
                        ...this.advanced.custom,
                        ...cfg.custom
                    };
                }
                if (cfg.adviceMeta) {
                    this.advanced.adviceMeta = cfg.adviceMeta;
                }
                this.persistAdvancedSettings();
                this.applyAdvancedState();
            }
            this.persistAdvancedSettings();
            this.applyAdvancedState();
            
            const html = `
                <form id="profileForm" style="display:flex;flex-direction:column;gap:24px;color:#24412F">
                    <div class="input-group">
                        <h4 style="margin-bottom:8px">Info Personal</h4>
                        <div class="input-group">
                            <input type="text" id="fullName" value="${escapeAttr(displayName)}" placeholder="Nama Lengkap">
                        </div>
                        <div class="input-group">
                            <input type="email" value="${escapeAttr(p.email || user.email)}" disabled style="background:rgba(255,255,254,0.75);color:#567a60">
                        </div>
                        <div class="input-group">
                            <input type="tel" id="phone" value="${escapeAttr(displayPhone)}" placeholder="Nomor Telepon">
                        </div>
                    </div>
                    <div class="input-group">
                        <h4 style="margin-bottom:8px">Peternakan</h4>
                        <div class="input-group">
                            <input type="text" id="farmName" value="${escapeAttr(displayFarmName)}" placeholder="Nama Peternakan">
                        </div>
                    </div>
                    <div style="display:flex;gap:12px;justify-content:flex-end">
                        <button type="button" id="cancelBtn" class="btn-action ghost">Batal</button>
                        <button type="submit" class="btn-action accent">Simpan</button>
                    </div>
                </form>
            `;
            
            const modalBody = document.querySelector('.petok-modal-body');
            if (modalBody) {
                modalBody.innerHTML = html;
            }
            
            document.getElementById('cancelBtn')?.addEventListener('click', () => this.closeModal());
            document.getElementById('profileForm')?.addEventListener('submit', async (e) => {
                e.preventDefault();
                try {
                    const sb = await getSb();
                    const advancedConfigPayload = {
                        basis: this.advanced.basis,
                        dressing: this.advanced.dressing,
                        processCost: this.advanced.processCost,
                        harvestAge: this.advanced.harvestAge,
                        wastagePct: this.advanced.wastagePct,
                        shrinkagePct: this.advanced.shrinkagePct,
                        laborCost: this.advanced.laborCost,
                        overheadCost: this.advanced.overheadCost,
                        transportCost: this.advanced.transportCost,
                        heatingCost: this.advanced.heatingCost,
                        vaccineCost: this.advanced.vaccineCost,
                        notes: this.advanced.notes,
                        custom: this.advanced.custom,
                        adviceMeta: this.advanced.adviceMeta
                    };
                    const { error } = await sb.rpc('update_user_profile', {
                        p_full_name: document.getElementById('fullName').value || null,
                        p_phone: document.getElementById('phone').value || null,
                        p_location: null,
                        p_farm_name: document.getElementById('farmName').value || null,
                        p_farm_type: null,
                        p_advanced_mode: this.advanced.enabled,
                        p_advanced_config: advancedConfigPayload
                    });
                    if (error) throw error;
                    this.closeModal();
                    this.notify('Saved!', 'success');
                } catch (e) {
                    console.error('Update profile error:', e);
                    this.notify('Error', 'error');
                }
            });
        } catch (e) {
            console.error('Profile load error', e);
            const modalBody = document.querySelector('.petok-modal-body');
            if (modalBody) {
                modalBody.innerHTML = '<p style="text-align:center;color:#C8513A;padding:40px">Gagal memuat profil</p>';
            }
        }
        finally {
            this.profileLoading = false;
        }
    }

    async exportPDF() {
        if (!this.checkAuth()) return;

        // Dynamic load jsPDF
        if (!window.jspdf) {
            this.notify('Memuat library PDF...', 'info');
            try {
                await new Promise((resolve, reject) => {
                    const script = document.createElement('script');
                    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
                    script.onload = resolve;
                    script.onerror = reject;
                    document.head.appendChild(script);
                });
            } catch (e) {
                this.notify('Gagal memuat library PDF', 'error');
                return;
            }
        }

        const jsPDF = window.jspdf.jsPDF;
        if (!jsPDF) {
            this.notify('PDF lib not loaded', 'error');
            return;
        }

        try {
            const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
            const pageWidth = doc.internal.pageSize.getWidth();
            const pageHeight = doc.internal.pageSize.getHeight();
            const marginX = 18;
            const marginY = 18;

            const data = this.getData();
            const jenisDisplay = data.chickenType === 'broiler' ? 'Broiler' : 'Ayam Kampung';
            const basisLabel = data.basis === 'carcass' ? 'kg karkas' : 'kg hidup';
            const priceDisplay = data.marketPrice > 0 ? `${this.fmt(data.marketPrice)}/${basisLabel}` : '—';
            const ekorDisplay = `${data.ekorPanen.toLocaleString('id-ID')} ekor`;
            const marginDisplay = data.margin != null ? `${(data.margin * 100).toFixed(1)}%` : '—';

            // Header band
            doc.setFillColor(58, 125, 71);
            doc.rect(0, 0, pageWidth, 48, 'F');
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(22);
            doc.setTextColor(255, 255, 255);
            doc.text('Petok Predict', marginX, 26);
            doc.setFontSize(12);
            doc.setFont('helvetica', 'normal');
            doc.text('Ringkasan Kalkulasi Peternakan', marginX, 36);
            doc.text(`Tanggal: ${new Date().toLocaleDateString('id-ID')}`, pageWidth - marginX, 26, { align: 'right' });
            doc.text(`Segment: ${jenisDisplay}`, pageWidth - marginX, 36, { align: 'right' });

            // Background panel
            doc.setFillColor(247, 251, 233);
            doc.roundedRect(marginX, 54, pageWidth - marginX * 2, pageHeight - 72, 6, 6, 'F');

            // Highlight cards
            const cardWidth = (pageWidth - marginX * 2 - 16) / 3;
            const highlightY = 64;
            const highlightCards = [
                { label: 'Pendapatan Bruto', value: this.fmt(data.totalPendapatan), stroke: [99, 180, 99], fill: [232, 248, 225], note: priceDisplay },
                { label: 'Total Biaya', value: this.fmt(data.totalBiaya), stroke: [224, 138, 61], fill: [255, 241, 218], note: `Biaya/Ekor ${this.fmt(Math.round(data.totalBiaya / Math.max(data.ekorPanen, 1)))}` },
                { label: 'Keuntungan Bersih', value: this.fmt(data.keuntungan), stroke: [63, 133, 82], fill: [224, 242, 214], note: `Margin ${marginDisplay}` }
            ];

            highlightCards.forEach((card, idx) => {
                const x = marginX + idx * (cardWidth + 8);
                doc.setDrawColor(card.stroke[0], card.stroke[1], card.stroke[2]);
                doc.setFillColor(card.fill[0], card.fill[1], card.fill[2]);
                doc.roundedRect(x, highlightY, cardWidth, 28, 4, 4, 'FD');
                doc.setTextColor(47, 81, 50);
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(10);
                doc.text(card.label.toUpperCase(), x + 6, highlightY + 10);
                doc.setFontSize(13);
                doc.text(card.value, x + 6, highlightY + 21);
                if (card.note) {
                    doc.setFont('helvetica', 'normal');
                    doc.setFontSize(9);
                    doc.text(card.note, x + 6, highlightY + 26);
                    doc.setFont('helvetica', 'bold');
                }
            });

            const sectionStartY = highlightY + 40;
            let cursorY = sectionStartY;
            const sectionPadding = 6;
            const contentWidth = pageWidth - marginX * 2;
            const columnSplitX = marginX + contentWidth / 2;
            let rightColumnBottom = sectionStartY;

            const fmtCurrency = (val) => Number.isFinite(val) ? this.fmt(Math.round(val)) : '—';
            const fmtMaybe = (val) => Number.isFinite(val) ? fmtCurrency(val) : '—';

            const sections = [
                {
                    title: 'Asumsi Produksi',
                    rows: [
                        ['Populasi', `${data.populasi.toLocaleString('id-ID')} ekor`],
                        ['Survival Rate', `${(data.survival * 100).toFixed(1)} %`],
                        ['Bobot Panen', `${data.bobot.toFixed(2)} kg`],
                        ['Harga Pakan/Sak', fmtCurrency(data.hargaPakan)]
                    ]
                },
                {
                    title: 'Komponen Biaya',
                    rows: [
                        ['Biaya DOC', fmtCurrency(data.biayaDoc)],
                        ['Biaya Pakan', fmtCurrency(data.biayaPakan)],
                        ['Vaksin & Vitamin', fmtCurrency(data.biayaVaksin)],
                        ['Energi/Pemanas', fmtCurrency(data.biayaEnergi)],
                        ['Tenaga Kerja', fmtCurrency(data.biayaLabor)],
                        ['Overhead', fmtCurrency(data.biayaOverhead)],
                        ['Transport & Komisi', fmtCurrency(data.biayaTransport)],
                        ['Total Biaya', fmtCurrency(data.totalBiaya)]
                    ]
                },
                {
                    title: 'Ikhtisar Pasar',
                    rows: [
                        ['Jenis Ayam', jenisDisplay],
                        ['Harga Jual', priceDisplay],
                        ['Ekor Panen', ekorDisplay],
                        ['Catatan Sumber', this.price?.source ? this.price.source : '—']
                    ]
                }
            ];

            if (data.isAdvanced) {
                sections.push({
                    title: 'Metrix Advance',
                    rows: [
                        ['Basis Harga', data.basis === 'carcass' ? 'Karkas' : 'Bobot hidup'],
                        ['Umur Panen', `${data.harvestAge} hari`],
                        ['Wastage Pakan', `${(data.wastagePct * 100).toFixed(1)} %`],
                        ['Break-even Price', fmtMaybe(data.breakEven)],
                        ['Cost per Kg', fmtMaybe(data.costPerKg)],
                        ['EPEF', data.epef ? data.epef.toFixed(1) : '—']
                    ]
                });
            }

            doc.setTextColor(47, 81, 50);
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(12);

            sections.forEach((section, index) => {
                const isRightColumn = index === 1;
                if (!isRightColumn && index > 1) {
                    cursorY = Math.max(cursorY, rightColumnBottom);
                }
                const baseX = isRightColumn ? columnSplitX + sectionPadding : marginX + sectionPadding;
                const widthAdjust = (contentWidth / 2) - sectionPadding * 2;
                const headerY = isRightColumn ? sectionStartY : cursorY;

                if (isRightColumn && headerY < cursorY) {
                    cursorY = headerY;
                }

                doc.text(section.title, baseX, cursorY);
                doc.setDrawColor(99, 180, 99);
                doc.setLineWidth(0.4);
                doc.line(baseX, cursorY + 2.5, baseX + widthAdjust, cursorY + 2.5);
                let rowY = cursorY + 8;

                doc.setFont('helvetica', 'normal');
                doc.setFontSize(10);
                section.rows.forEach(row => {
                    doc.text(row[0], baseX, rowY);
                    doc.text(row[1], baseX + widthAdjust, rowY, { align: 'right' });
                    rowY += 6.5;
                });

                if (isRightColumn) {
                    rightColumnBottom = rowY + 6;
                } else {
                    cursorY = rowY + 6;
                }
            });

            // Footer notes
            doc.setFont('helvetica', 'italic');
            doc.setFontSize(9);
            doc.setTextColor(111, 141, 98);
            doc.text('Laporan otomatis Petok Predict — parameter bisa disesuaikan kembali di aplikasi sebelum ekspor ulang.', marginX + 2, pageHeight - 20);

            if (data.notes) {
                doc.setFont('helvetica', 'normal');
                doc.setFontSize(9);
                doc.setTextColor(70, 105, 78);
                const noteY = Math.max(cursorY, rightColumnBottom) + 6;
                doc.text('Catatan Rekomendasi:', marginX + 2, noteY);
                const wrapped = doc.splitTextToSize(data.notes, contentWidth - 4);
                doc.text(wrapped, marginX + 2, noteY + 6);
            }

            doc.save(`petok-predict-${new Date().toISOString().split('T')[0]}.pdf`);
            this.notify('PDF Downloaded!', 'success');
        } catch (e) {
            this.notify('PDF Error', 'error');
        }
    }

    modal(title, content, onClose) {
        this.closeModal();

        const overlay = document.createElement('div');
        overlay.id = 'petokModal';
        overlay.style.position = 'fixed';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.background = 'rgba(47, 81, 50, 0.38)';
        overlay.style.zIndex = '10000';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');

        const container = document.createElement('div');
        container.style.background = 'rgba(255,255,252,0.96)';
        container.style.border = '1px solid rgba(137,173,146,0.4)';
        container.style.borderRadius = '12px';
        container.style.padding = '24px';
        container.style.maxWidth = '600px';
        container.style.width = '90%';
        container.style.maxHeight = '80vh';
        container.style.overflowY = 'auto';
        container.style.boxShadow = '0 24px 48px rgba(96,122,86,0.24)';

        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.marginBottom = '16px';

        const titleEl = document.createElement('h3');
        titleEl.style.margin = '0';
        titleEl.style.color = '#2F5132';
        titleEl.textContent = title;

        const body = document.createElement('div');
        body.className = 'petok-modal-body';
        body.innerHTML = content;

        header.appendChild(titleEl);
        container.appendChild(header);
        container.appendChild(body);
        overlay.appendChild(container);
        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                this.closeModal();
                if (typeof onClose === 'function') onClose();
            }
        });
    }

    closeModal() {
        // Reset captcha if exists
        if (captchaWidgetId !== null && window.hcaptcha) {
            try {
                window.hcaptcha.reset(captchaWidgetId);
            } catch (e) {
                // Ignore if widget not found
            }
            captchaWidgetId = null;
        }
        document.getElementById('petokModal')?.remove();
    }

    notify(msg, type = 'info') {
        const div = document.createElement('div');
        div.textContent = msg;
    div.style.cssText = `position:fixed;top:20px;right:20px;padding:16px 24px;border-radius:8px;z-index:10001;background:${type==='success'?'#3F8F5F':'#C8513A'};color:#fff;font-weight:500`;
        document.body.appendChild(div);
        setTimeout(() => div.remove(), 3000);
    }

    openAdvancedConfigurator(isActivation = false) {
        const custom = this.advanced.custom || {};
        const extras = Array.isArray(custom.extras) ? custom.extras : [];

        const html = `
            <div class="advanced-config">
                <p class="helper-text" style="margin-bottom:16px">Masukkan detail spesifikasi kandang Anda agar rekomendasi biaya lebih akurat.</p>
                
                <div id="customFields" class="form-grid">
                    <div class="input-group">
                        <label>Panjang kandang (m)</label>
                        <input type="number" id="customLength" min="1" step="0.5" value="${custom.length ?? ''}" placeholder="Misal 12">
                    </div>
                    <div class="input-group">
                        <label>Lebar kandang (m)</label>
                        <input type="number" id="customWidth" min="1" step="0.5" value="${custom.width ?? ''}" placeholder="Misal 8">
                    </div>
                    <div class="input-group">
                        <label>Tinggi rata-rata (m)</label>
                        <input type="number" id="customHeight" min="1" step="0.5" value="${custom.height ?? ''}" placeholder="Misal 2.8">
                    </div>
                    <div class="input-group">
                        <label>Sistem ventilasi</label>
                        <select id="customVentilation">
                            <option value="konvensional" ${custom.ventilation==='konvensional'?'selected':''}>Konvensional (ventilasi alami)</option>
                            <option value="tunnel" ${custom.ventilation==='tunnel'?'selected':''}>Tunnel fan</option>
                            <option value="mixed" ${custom.ventilation==='mixed'?'selected':''}>Campuran</option>
                        </select>
                    </div>
                </div>

                <fieldset style="border:1px solid rgba(137,173,146,0.45);padding:16px;border-radius:10px;display:grid;gap:10px;margin-top:8px">
                    <legend style="padding:0 8px;color:#3F8F5F;font-weight:600">Fitur tambahan</legend>
                    ${[{
                        key: 'autoBrooder', label: 'Ada pemanas otomatis atau gas brooder'
                    }, {
                        key: 'curtain', label: 'Menggunakan tirai/kasa untuk kontrol suhu'
                    }, {
                        key: 'fogger', label: 'Ada fogger atau sprayer pendingin'
                    }, {
                        key: 'lighting', label: 'Menggunakan lampu LED hemat energi'
                    }].map(item => `
                        <label style="display:flex;gap:10px;align-items:center;cursor:pointer">
                            <input type="checkbox" data-extra="${item.key}" ${extras.includes(item.key)?'checked':''}>
                            <span>${item.label}</span>
                        </label>
                    `).join('')}
                </fieldset>

                <div style="display:flex;justify-content:flex-end;gap:12px;margin-top:24px">
                    <button type="button" id="cancelAdvConfig" class="btn-action ghost">Batal</button>
                    <button type="button" id="saveAdvConfig" class="btn-action accent">Simpan & Update</button>
                </div>
            </div>
        `;

        const onCancel = () => {
            if (isActivation) {
                this.toggleAdvancedMode(false, { skipConfigurator: true, skipAdvice: true });
            }
        };

        this.modal('Pengaturan Advance', html, onCancel);

        const modal = document.querySelector('.petok-modal-body');
        if (!modal) return;

        modal.querySelector('#cancelAdvConfig')?.addEventListener('click', () => {
            this.closeModal();
            onCancel();
        });
        modal.querySelector('#saveAdvConfig')?.addEventListener('click', () => {
            const len = Number(modal.querySelector('#customLength')?.value || 0) || null;
            const wid = Number(modal.querySelector('#customWidth')?.value || 0) || null;
            const hei = Number(modal.querySelector('#customHeight')?.value || 0) || null;
            const vent = modal.querySelector('#customVentilation')?.value || 'konvensional';
            const chosen = Array.from(modal.querySelectorAll('[data-extra]'))
                .filter(el => el.checked)
                .map(el => el.getAttribute('data-extra'));
            
            this.advanced.custom = {
                length: len,
                width: wid,
                height: hei,
                ventilation: vent,
                extras: chosen
            };

            this.persistAdvancedSettings();
            this.closeModal();
            this.applyAdvancedState();
            this.generateAdvancedAdvice();
        });
    }

    setText(id, text) {
        if (!this.ui[id]) {
            this.ui[id] = document.getElementById(id);
        }
        if (this.ui[id]) this.ui[id].textContent = text;
    }

    fmt(num) {
        return new Intl.NumberFormat('id-ID', {
            style: 'currency',
            currency: 'IDR',
            minimumFractionDigits: 0
        }).format(num);
    }
}

// ========================================
// CAPTCHA CALLBACK
// ========================================

window.onCaptchaSuccess = function(token) {
    const calc = window.chickenCalcInstance;
    if (calc) calc.saveWithCaptcha(token);
};

// ========================================
// TOOLTIP HANDLER
// ========================================

const tooltip = document.createElement('div');
tooltip.className = 'global-tooltip';
document.body.appendChild(tooltip);

const showTooltip = (e) => {
    const target = e.target.closest('[data-tooltip]');
    if (!target) {
        tooltip.classList.remove('active');
        return;
    }
    
    const text = target.getAttribute('data-tooltip');
    if (!text) return;

    tooltip.textContent = text;
    tooltip.classList.add('active');
    
    const rect = target.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();
    
    let left = rect.left + (rect.width / 2) - (tipRect.width / 2);
    let top = rect.top - tipRect.height - 8;

    // Horizontal clamp
    if (left < 10) left = 10;
    if (left + tipRect.width > window.innerWidth - 10) {
        left = window.innerWidth - tipRect.width - 10;
    }

    // Vertical flip
    if (top < 10) {
        top = rect.bottom + 8;
    }

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
};

document.addEventListener('mouseover', showTooltip);
document.addEventListener('touchstart', showTooltip, {passive: true});
window.addEventListener('scroll', () => tooltip.classList.remove('active'), {passive: true});

// ========================================
// INIT
// ========================================

document.addEventListener('DOMContentLoaded', async () => {
    try {
        // Load config first
        await loadConfig();
        
        // Initialize auth and calculator
        initGoogleAuth();
        window.chickenCalcInstance = new ChickenCalc();
        await updateAuthUI();
        
        // Setup auth state listener
        const sb = await getSb();
        sb.auth.onAuthStateChange(async (_, session) => {
            await updateAuthUI(session);
            if (session?.user) {
                try {
                    window.chickenCalcInstance?.closeModal();
                } catch (_) {
                    document.getElementById('petokModal')?.remove();
                }
            }
        });
    } catch (error) {
        console.error('❌ Initialization failed:', error);
    }
});

})();
