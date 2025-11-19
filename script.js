(() => {
'use strict';

// ========================================
// PETOK PREDICT - CLEAN & SIMPLE
// ========================================

let CONFIG = null;
let configLoaded = false;
let supabaseClient = null;
let googleAuthReady = false;
let googleButtonRendered = false;
let captchaWidgetId = null;

// Load config from Netlify Function
async function loadConfig() {
    if (configLoaded) return CONFIG;
    try {
        const response = await fetch('/api/config');
        if (!response.ok) throw new Error('Failed to load config');
        CONFIG = await response.json();
        supabaseClient = supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);
        configLoaded = true;
        return CONFIG;
    } catch (error) {
        console.error('Config load failed:', error);
        alert('Gagal memuat konfigurasi aplikasi. Silakan refresh halaman.');
        throw error;
    }
}

function getSb() {
    if (!supabaseClient) throw new Error('Supabase client not initialized.');
    return supabaseClient;
}

function deriveUserIdentity(user) {
    if (!user) return { fullName: '', email: '', picture: null };
    const metadata = user.user_metadata || {};
    const nameCandidates = [
        metadata.full_name,
        metadata.name,
        `${metadata.given_name || ''} ${metadata.family_name || ''}`.trim(),
        user.email ? user.email.split('@')[0] : ''
    ].filter(Boolean);

    return {
        fullName: nameCandidates[0] || '',
        email: user.email || '',
        picture: metadata.avatar_url || metadata.picture || metadata.image || metadata.avatar || null
    };
}

// ========================================
// GOOGLE AUTH
// ========================================

async function initGoogleAuth() {
    await loadConfig();
    if (!CONFIG || CONFIG.googleClientId.includes('YOUR_')) return;

    const loginContainer = document.getElementById('login-btn');
    if (!loginContainer) return;

    const setup = () => {
        if (googleAuthReady || !window.google?.accounts?.id) return;
        googleAuthReady = true;

        google.accounts.id.initialize({
            client_id: CONFIG.googleClientId,
            callback: async (response) => {
                try {
                    const sb = getSb();
                    const { error } = await sb.auth.signInWithIdToken({
                        provider: 'google',
                        token: response.credential
                    });
                    if (error) throw error;
                    await updateAuthUI();
                } catch (e) {
                    alert('Login gagal: ' + e.message);
                }
            },
            cancel_on_tap_outside: false
        });

        if (!googleButtonRendered) {
            google.accounts.id.renderButton(loginContainer, {
                theme: 'filled_blue',
                size: 'large',
                text: 'signin_with',
                width: 240,
                logo_alignment: 'left'
            });
            googleButtonRendered = true;
        }
    };

    if (window.google?.accounts?.id) {
        setup();
    } else {
        const gisScript = document.querySelector('script[src*="accounts.google.com/gsi/client"]');
        if (gisScript) gisScript.addEventListener('load', setup, { once: true });
    }
}

async function logout() {
    try {
        applyAuthState(null);
        const sb = getSb();
        await sb.auth.signOut();
        if (window.google?.accounts?.id) {
            google.accounts.id.disableAutoSelect();
        }
    } catch (e) {
        console.error('Logout failed', e);
    } finally {
        updateAuthUI();
    }
}

function applyAuthState(session) {
    const loginContainer = document.getElementById('login-btn');
    const userBox = document.getElementById('user-box');
    const userName = document.getElementById('user-name');
    const userAvatar = document.getElementById('user-avatar');
    const saveBtn = document.getElementById('saveCalculation');
    const historyBtn = document.getElementById('viewHistory');
    const saveInfo = document.getElementById('saveInfo');

    if (session?.user) {
        const identity = deriveUserIdentity(session.user);
        if (loginContainer) loginContainer.style.display = 'none';
        if (userBox) userBox.style.display = 'flex';
        if (userName) userName.textContent = identity.fullName || session.user.email;
        if (userAvatar) {
            if (identity.picture) {
                userAvatar.src = identity.picture;
                userAvatar.style.display = 'block';
                userBox.classList.add('has-avatar');
            } else {
                userAvatar.style.display = 'none';
                userBox.classList.remove('has-avatar');
            }
        }
        if (saveBtn) saveBtn.style.display = 'inline-block';
        if (historyBtn) historyBtn.style.display = 'inline-block';
        if (saveInfo) saveInfo.style.display = 'inline';
        localStorage.setItem('pp_user', JSON.stringify({ id: session.user.id }));
    } else {
        if (loginContainer) {
            loginContainer.style.display = 'flex';
            if (googleAuthReady && window.google?.accounts?.id && !googleButtonRendered) {
                loginContainer.innerHTML = '';
                google.accounts.id.renderButton(loginContainer, {
                    theme: 'filled_blue',
                    size: 'large',
                    text: 'signin_with',
                    width: 240,
                    logo_alignment: 'left'
                });
                googleButtonRendered = true;
            }
        }
        if (userBox) userBox.style.display = 'none';
        if (saveBtn) saveBtn.style.display = 'none';
        if (historyBtn) historyBtn.style.display = 'none';
        if (saveInfo) saveInfo.style.display = 'none';
        localStorage.removeItem('pp_user');
    }
    document.body.classList.add('auth-ready');
}

async function updateAuthUI(sessionOverride) {
    if (sessionOverride !== undefined) {
        applyAuthState(sessionOverride);
        return;
    }
    const sb = getSb();
    const { data: { session } } = await sb.auth.getSession();
    applyAuthState(session);
}

// ========================================
// CALCULATOR
// ========================================

class ChickenCalc {
    constructor() {
        this.price = null;
        this.priceOverride = { market: null };
        this.assumptions = {
            pop: 100,
            survival: 0.95,
            weight: 1.0,
            feed: 400000,
            fcr: 2.3,
            doc: 8000
        };
        this.advanced = this.loadAdvancedSettings();
        this.activeTab = 'asumsi';
        this.init();
    }

    init() {
        this.bind();
        this.applyAdvancedState();
        this.fetchPrice('kampung');
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
                    vaccineCost: saved.vaccineCost ?? 100000
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
            vaccineCost: 100000
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
        
        const isEnabled = this.advanced.enabled;
        if (stats) stats.style.display = isEnabled ? 'grid' : 'none';
        if (banner) banner.style.display = isEnabled ? 'block' : 'none';
        if (controls) controls.style.display = isEnabled ? 'grid' : 'none';
        if (toggleRow) toggleRow.style.display = 'flex';

        if (!isEnabled) {
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

        // Basis buttons
        document.querySelectorAll('#basisSwitch .basis-btn').forEach(btn => {
            btn?.classList.toggle('active', btn.dataset.basis === this.advanced.basis);
        });

        document.querySelectorAll('.advanced-only').forEach(el => {
            const basis = el.getAttribute('data-basis');
            if (!basis) return;
            el.style.display = this.advanced.enabled && basis === this.advanced.basis ? '' : 'none';
        });

        if (!this.advanced.enabled) return;

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
    }

    syncAdvancedToggleUI() {
        const mainSwitch = document.getElementById('advancedModeSwitch');
        if (mainSwitch) {
            const isOn = !!this.advanced?.enabled;
            mainSwitch.classList.toggle('active', isOn);
            mainSwitch.setAttribute('aria-pressed', isOn ? 'true' : 'false');
        }
    }

    toggleAdvancedMode() {
        this.advanced.enabled = !this.advanced.enabled;
        this.persistAdvancedSettings();
        this.applyAdvancedState();
        this.calc();
        if (document.getElementById('tabSimulasiContent')?.classList.contains('active')) {
            this.renderSim();
        }
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

        document.getElementById('logout-btn')?.addEventListener('click', logout);
        document.getElementById('saveCalculation')?.addEventListener('click', () => this.save());
        document.getElementById('viewHistory')?.addEventListener('click', () => this.showHistory());
        document.getElementById('exportPdfDashboard')?.addEventListener('click', () => this.exportPDF());
        document.getElementById('quickHistory')?.addEventListener('click', () => this.showHistory());

        const mainAdvancedSwitch = document.getElementById('advancedModeSwitch');
        if (mainAdvancedSwitch) {
            mainAdvancedSwitch.addEventListener('click', () => this.toggleAdvancedMode());
        }

        const asumsiTabBtn = document.getElementById('tabAsumsi');
        const simulasiTabBtn = document.getElementById('tabSimulasi');
        asumsiTabBtn?.addEventListener('click', () => this.tab('asumsi'));
        simulasiTabBtn?.addEventListener('click', () => this.tab('simulasi'));

        this.bindSliders();
        this.bindAdvancedControls();
        this.bindPriceEditing();
    }

    updateChickenToggle(value) {
        document.querySelectorAll('#chickenTabs .tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.type === value);
        });
    }

    bindAdvancedControls() {
        document.querySelectorAll('#basisSwitch .basis-btn').forEach(btn => {
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
            { id: 'rangeHarvestAge', prop: 'harvestAge', fmt: (v) => Number(v), displayId: 'valHarvestAge' },
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
                this.calc();
                if (document.getElementById('tabSimulasiContent')?.classList.contains('active')) {
                    this.renderSim();
                }
            });
        });
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
                const disp = document.getElementById(sl.d);
                if (disp) disp.textContent = sl.f(sl.s ? val : val);
                this.calc();
                if (document.getElementById('tabSimulasiContent')?.classList.contains('active')) {
                    this.renderSim();
                }
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
            if (this.priceOverride.market == null) {
                const input = document.getElementById('inputMarketPrice');
                if (input && data.price) input.value = Math.round(data.price);
            }
            this.calc();
            if (document.getElementById('tabSimulasiContent')?.classList.contains('active')) {
                this.renderSim();
            }
        } catch (e) {
            this.price = null;
            const h = document.getElementById('statHarga');
            if (h) h.textContent = 'Error';
        }
    }

    bindPriceEditing() {
        const btnEdit = document.getElementById('btnEditMarket');
        const btnApply = document.getElementById('btnApplyMarket');
        const row = document.getElementById('marketEditRow');
        const input = document.getElementById('inputMarketPrice');

        btnEdit?.addEventListener('click', () => {
            row.style.display = row.style.display === 'none' ? 'grid' : 'none';
            if (row.style.display === 'grid') input?.focus();
        });
        btnApply?.addEventListener('click', () => {
            const val = Number(input?.value || 0);
            if (Number.isFinite(val) && val > 0) {
                this.priceOverride.market = val;
                this.calc();
                row.style.display = 'none';
            }
        });
    }

    computeEconomics(overrides = {}, options = {}) {
        const chickenType = (options.chickenType || document.getElementById('chickenType')?.value || 'kampung').toLowerCase();
        const isBroiler = chickenType === 'broiler';
        const base = this.assumptions;

        const pop = Math.max(1, Math.round(overrides.pop ?? base.pop));
        const survival = Math.min(Math.max(Number(overrides.survival ?? base.survival) || 0, 0), 1);
        const weight = Number(overrides.weight ?? base.weight) || 1;
        const feedPrice = Math.max(1, Math.round(overrides.feed ?? base.feed));
        const fcr = Number(overrides.fcr ?? base.fcr) || 2.0;
        const docPrice = Math.max(0, Math.round(overrides.doc ?? base.doc));

        const priceInput = options.price ?? (this.priceOverride.market || this.price?.price);
        const priceValid = typeof priceInput === 'number' && priceInput > 0;

        const advancedActive = !!this.advanced?.enabled;
        const wastagePct = advancedActive ? Math.max(0, Number(this.advanced.wastagePct ?? 0)) : (isBroiler ? 0.05 : 0);
        const shrinkagePct = advancedActive ? Math.max(0, Number(this.advanced.shrinkagePct ?? 0)) : 0;
        const shrinkageFactor = Math.max(0, 1 - shrinkagePct);
        const harvestAge = advancedActive ? Math.max(1, Math.round(this.advanced.harvestAge || (isBroiler ? 35 : 70))) : (isBroiler ? 35 : 70);
        const basis = advancedActive && this.advanced.basis === 'carcass' ? 'carcass' : 'live';
        const dressing = basis === 'carcass' ? Math.min(Math.max(Number(this.advanced.dressing ?? 0.72), 0.45), 0.9) : 0.72;
        const processCost = basis === 'carcass' ? Math.max(0, Math.round(this.advanced.processCost ?? 0)) : 0;

        const harvest = Math.round(pop * survival);
        const feedKgPrice = feedPrice / 50;
        const feedCostPerBird = feedKgPrice * (1 + wastagePct) * fcr * weight;
        const totalFeedCost = Math.round(pop * Math.round(feedCostPerBird));
        const docCost = Math.round(pop * docPrice);

        const baseVacCost = Math.ceil(pop / 100) * 150000;
        const baseEnergyCost = Math.round(Math.ceil(pop / 100) * 10 * 504 / 1000 * 1444.70);

        const vaccineCost = advancedActive ? Number(this.advanced.vaccineCost ?? baseVacCost) : baseVacCost;
        const energyCost = advancedActive ? Number(this.advanced.heatingCost ?? baseEnergyCost) : baseEnergyCost;
        const laborCost = advancedActive ? Number(this.advanced.laborCost ?? 0) : 0;
        const overheadCost = advancedActive ? Number(this.advanced.overheadCost ?? 0) : 0;
        const transportCost = advancedActive ? Number(this.advanced.transportCost ?? 0) : 0;

        const extraCost = vaccineCost + energyCost + laborCost + overheadCost + transportCost;
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
            chickenType, pop, survival, weight, feedPrice, fcr, docPrice, harvest,
            feedCostPerBird: Math.round(feedCostPerBird), totalFeedCost, docCost,
            vaccineCost, energyCost, laborCost, overheadCost, transportCost, extraCost, totalCost,
            price: priceValid ? priceInput : null, priceValid, revenue, profit, margin,
            basis, dressing, processCost, wastagePct, shrinkagePct, harvestAge,
            costPerKg, breakEven, epef, advancedActive, productionKg
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
        this.setText('statBiayaDoc', this.fmt(result.docCost));
        this.setText('statBiayaPakanEkor', this.fmt(result.feedCostPerBird));
        this.setText('statBiayaTambahan', this.fmt(result.extraCost));
        this.setText('statEkorPanen', `${result.harvest.toLocaleString('id-ID')} ekor`);
        this.setText('statTotalBiaya', this.fmt(result.totalCost));
        this.setText('statPendapatan', result.revenue != null ? this.fmt(result.revenue) : 'Menunggu harga');
        this.setText('statKeuntungan', result.profit != null ? this.fmt(result.profit) : 'Menunggu harga');

        this.updateBars(result.revenue ?? 0, result.totalCost, result.profit ?? 0);

        // Harvest estimate
        const est = this.estimateHarvestDays(result.fcr, result.weight, result.chickenType);
        this.setText('statHarvestEstimate', `${est.min}–${est.max} hari`);

        if (result.advancedActive) {
            this.setText('statCostPerKg', result.costPerKg ? this.fmt(result.costPerKg) : '–');
            this.setText('statBreakEven', result.breakEven ? this.fmt(result.breakEven) : '–');
            const epefEl = document.getElementById('statEpef');
            if (epefEl) epefEl.textContent = Number.isFinite(result.epef) ? result.epef.toFixed(1) : '–';
        }
    }

    updateBars(rev, cost, profit) {
        const bars = {
            pendapatanProgress: 100,
            biayaProgress: rev > 0 ? Math.min((cost / rev) * 100, 100) : 0,
            keuntunganProgress: rev > 0 && profit > 0 ? Math.min((profit / rev) * 100, 100) : 0
        };
        Object.keys(bars).forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.width = bars[id] + '%';
        });
    }

    tab(t) {
        const next = t === 'simulasi' ? 'simulasi' : 'asumsi';
        if (next === this.activeTab) return;

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
        if (next === 'simulasi') this.renderSim();
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
                overrides: { ...base }
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
        let html = '';
        scenarios.forEach(({ name, note, overrides }) => {
            const result = this.computeEconomics(overrides, {
                price: this.priceOverride.market || this.price?.price,
                scaleAgainstPop: this.assumptions.pop,
                chickenType: document.getElementById('chickenType')?.value || 'kampung'
            });
            const icon = result.profit == null ? '—' : (result.profit > 0 ? '📈' : '📉');
            const col = result.profit == null ? '#567A60' : (result.profit > 0 ? '#3F8F5F' : '#C8513A');
            const costPerBird = result.harvest > 0 ? Math.round(result.totalCost / result.harvest) : null;
            const marginLabel = result.margin != null ? `${(result.margin * 100).toFixed(1)}%` : '—';
            
            html += `
                <div style="background:rgba(255,255,254,0.95);padding:20px;border-radius:12px;border:1px solid rgba(137,173,146,0.4);box-shadow:0 18px 32px rgba(41,71,54,0.2);color:#24412F;display:flex;flex-direction:column;gap:10px">
                    <div><h4 style="margin:0 0 4px">${name}</h4><small style="color:#567A60">${note}</small></div>
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
                        <div><b>Pendapatan:</b> ${fmtCurrency(result.revenue)}</div>
                        <div style="font-weight:700;color:${col}"><b>Profit:</b> ${icon} ${fmtCurrency(result.profit)}</div>
                        <div><b>Margin:</b> ${marginLabel}</div>
                    </div>
                </div>
            `;
        });
        c.innerHTML = html;
    }

    async save() {
        const user = JSON.parse(localStorage.getItem('pp_user') || 'null');
        if (!user) { alert('Login dulu'); return; }
        this.showCaptchaModal();
    }

    showCaptchaModal() {
        const html = `
            <div id="captchaStep" style="text-align:center">
                <p style="color:#567a60;margin-bottom:16px">Verifikasi dulu ya:</p>
                <div id="hcaptcha-container"></div>
            </div>
            <div id="notesStep" style="display:none">
                <p style="color:#567a60;margin-bottom:12px">✅ Verifikasi berhasil!</p>
                <label style="display:block;margin-bottom:8px;font-weight:500;color:#24412F">Catatan (opsional):</label>
                <textarea id="notesInput" placeholder="Tambahkan catatan..." style="width:100%;min-height:80px;padding:12px;border:1px solid rgba(137,173,146,0.4);border-radius:8px;background:rgba(255,255,254,0.84)"></textarea>
                <div style="display:flex;gap:12px;margin-top:16px;justify-content:flex-end">
                    <button id="cancelSave" style="padding:10px 20px;border:1px solid rgba(137,173,146,0.4);background:#fff;border-radius:6px;cursor:pointer;color:#567a60">Batal</button>
                    <button id="confirmSave" style="padding:10px 20px;border:none;background:#3F8F5F;color:#f2fff4;border-radius:6px;cursor:pointer;font-weight:500">Simpan</button>
                </div>
            </div>
        `;
        this.modal('Simpan Perhitungan', html);
        setTimeout(() => {
            if (window.hcaptcha) {
                captchaWidgetId = window.hcaptcha.render('hcaptcha-container', {
                    sitekey: CONFIG?.captchaKey || '',
                    callback: 'onCaptchaSuccess'
                });
            }
        }, 100);
    }

    async saveWithCaptcha(token) {
        document.getElementById('captchaStep').style.display = 'none';
        document.getElementById('notesStep').style.display = 'block';
        document.getElementById('notesInput')?.focus();

        document.getElementById('cancelSave')?.addEventListener('click', () => this.closeModal());
        document.getElementById('confirmSave')?.addEventListener('click', async () => {
            const notes = document.getElementById('notesInput')?.value || null;
            try {
                const data = this.getData();
                if (!data.marketPrice || data.marketPrice <= 0) throw new Error('Harga pasar belum tersedia.');
                const sb = getSb();
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
                    p_epef: data.epef
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
        return {
            chickenType: result.chickenType,
            populasi: result.pop,
            survival: result.survival,
            bobot: result.weight,
            hargaPakan: result.feedPrice,
            fcr: result.fcr,
            docPrice: result.docPrice,
            marketPrice: result.priceValid ? result.price : (this.price?.price || 0),
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
            totalPendapatan: Number.isFinite(result.revenue) ? Math.round(result.revenue) : 0,
            keuntungan: Number.isFinite(result.profit) ? Math.round(result.profit) : 0,
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
            epef: result.epef
        };
    }

    async showHistory() {
        const user = JSON.parse(localStorage.getItem('pp_user') || 'null');
        if (!user) { alert('Login dulu'); return; }
        
        this.modal('History', '<div style="text-align:center;padding:40px">Memuat history...</div>');

        try {
            const sb = getSb();
            const { data: history, error } = await sb.rpc('get_recent_calculations', { limit_count: 20, offset_count: 0 });
            if (error) throw error;
            
            if (!history || history.length === 0) {
                document.querySelector('.petok-modal-body').innerHTML = '<p style="text-align:center;padding:40px">Belum ada history</p>';
                return;
            }

            let html = '<div style="max-height:400px;overflow-y:auto">';
            history.forEach(c => {
                const date = new Date(c.calculation_date).toLocaleDateString('id-ID');
                const icon = c.keuntungan_bersih > 0 ? '📈' : '📉';
                const col = c.keuntungan_bersih > 0 ? '#3F8F5F' : '#C8513A';
                const star = c.is_favorite ? '⭐' : '☆';
                
                html += `
                    <div style="border:1px solid rgba(137,173,146,0.36);border-radius:8px;padding:12px;margin-bottom:8px;background:rgba(255,255,254,0.9)">
                        <div style="display:flex;justify-content:space-between">
                            <div style="flex:1">
                                <div style="font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                                    <span>${c.chicken_type} - ${c.populasi} ekor</span>
                                    ${c.is_advanced ? '<span class="history-tag">Advance</span>' : ''}
                                    <button class="btn-fav" data-id="${c.id}" style="background:none;border:none;cursor:pointer">${star}</button>
                                </div>
                                <div style="font-size:0.85rem;color:#567a60">${date}</div>
                                <div style="font-weight:600;color:${col}">${icon} ${this.fmt(c.keuntungan_bersih)}</div>
                                ${c.notes ? `<div style="font-style:italic;color:#567a60;font-size:0.85rem">"${c.notes}"</div>` : ''}
                            </div>
                            <div style="display:flex;flex-direction:column;gap:4px">
                                <button class="btn-load" data-id="${c.id}" style="background:#3F8F5F;color:#f2fff4;border:none;padding:4px 8px;border-radius:4px;cursor:pointer">Muat</button>
                                <button class="btn-del" data-id="${c.id}" style="background:#C8513A;color:#fff;border:none;padding:4px 8px;border-radius:4px;cursor:pointer">Hapus</button>
                            </div>
                        </div>
                    </div>
                `;
            });
            html += '</div>';
            document.querySelector('.petok-modal-body').innerHTML = html;
            this.bindHistoryBtns();
        } catch (e) {
            document.querySelector('.petok-modal-body').innerHTML = '<p style="text-align:center;color:#C8513A;padding:40px">Gagal memuat history</p>';
        }
    }

    bindHistoryBtns() {
        document.querySelectorAll('.btn-fav').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.target.dataset.id;
                const sb = getSb();
                const { data: newStatus } = await sb.rpc('toggle_favorite_calculation', { calculation_id: id });
                e.target.textContent = newStatus ? '⭐' : '☆';
            });
        });
        document.querySelectorAll('.btn-load').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.target.dataset.id;
                const sb = getSb();
                const { data: calc } = await sb.from('calculation_history').select('*').eq('id', id).single();
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
                const id = e.target.dataset.id;
                const sb = getSb();
                await sb.rpc('delete_calculation', { calculation_id: id });
                e.target.closest('div[style*="border:1px"]').remove();
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

        if (c.is_advanced) {
            this.advanced.enabled = true;
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
            this.persistAdvancedSettings();
            this.applyAdvancedState();
        } else {
            this.advanced.enabled = false;
            this.persistAdvancedSettings();
            this.applyAdvancedState();
        }
        this.calc();
    }

    exportPDF() {
        const jsPDF = window.jsPDF || window.jspdf?.jsPDF;
        if (!jsPDF) { this.notify('PDF lib not loaded', 'error'); return; }

        try {
            const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
            const pageWidth = doc.internal.pageSize.getWidth();
            const marginX = 18;

            const data = this.getData();
            const jenisDisplay = data.chickenType === 'broiler' ? 'Broiler' : 'Ayam Kampung';
            const basisLabel = data.basis === 'carcass' ? 'kg karkas' : 'kg hidup';
            const priceDisplay = data.marketPrice > 0 ? `${this.fmt(data.marketPrice)}/${basisLabel}` : '—';

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

            let y = 60;
            doc.setTextColor(0, 0, 0);
            doc.setFontSize(12);
            doc.text(`Total Pendapatan: ${this.fmt(data.totalPendapatan)}`, marginX, y); y += 10;
            doc.text(`Total Biaya: ${this.fmt(data.totalBiaya)}`, marginX, y); y += 10;
            doc.text(`Keuntungan Bersih: ${this.fmt(data.keuntungan)}`, marginX, y); y += 20;
            
            doc.text('Detail:', marginX, y); y += 10;
            doc.setFontSize(10);
            doc.text(`Populasi: ${data.populasi}`, marginX, y); y += 6;
            doc.text(`Survival: ${(data.survival * 100).toFixed(1)}%`, marginX, y); y += 6;
            doc.text(`Bobot: ${data.bobot} kg`, marginX, y); y += 6;
            doc.text(`FCR: ${data.fcr}`, marginX, y); y += 6;
            
            doc.save(`petok-predict-${new Date().toISOString().split('T')[0]}.pdf`);
            this.notify('PDF Downloaded!', 'success');
        } catch (e) {
            this.notify('PDF Error', 'error');
        }
    }

    modal(title, content) {
        this.closeModal();
        const overlay = document.createElement('div');
        overlay.id = 'petokModal';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(47,81,50,0.38);z-index:10000;display:flex;align-items:center;justify-content:center';
        
        const container = document.createElement('div');
        container.style.cssText = 'background:rgba(255,255,252,0.96);border:1px solid rgba(137,173,146,0.4);border-radius:12px;padding:24px;max-width:600px;width:90%;max-height:80vh;overflow-y:auto;box-shadow:0 24px 48px rgba(96,122,86,0.24)';
        
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:16px';
        header.innerHTML = `<h3 style="margin:0;color:#2F5132">${title}</h3><button id="modalClose" style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:#567A60">&times;</button>`;
        
        const body = document.createElement('div');
        body.className = 'petok-modal-body';
        body.innerHTML = content;

        container.appendChild(header);
        container.appendChild(body);
        overlay.appendChild(container);
        document.body.appendChild(overlay);

        document.getElementById('modalClose').addEventListener('click', () => this.closeModal());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) this.closeModal(); });
    }

    closeModal() {
        if (captchaWidgetId !== null && window.hcaptcha) {
            try { window.hcaptcha.reset(captchaWidgetId); } catch (e) {}
            captchaWidgetId = null;
        }
        document.getElementById('petokModal')?.remove();
    }

    notify(msg, type = 'info') {
        const div = document.createElement('div');
        div.textContent = msg;
        div.className = `notification ${type}`;
        document.body.appendChild(div);
        setTimeout(() => div.remove(), 3000);
    }

    setText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    fmt(num) {
        return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(num);
    }

    estimateHarvestDays(fcr, weight, chickenType) {
        const type = (chickenType || '').toLowerCase();
        const isBroiler = type === 'broiler';
        const W = Math.max(0.6, Math.min(3.0, Number(weight) || 1.0));
        const F = Math.max(1.4, Math.min(3.2, Number(fcr) || (isBroiler ? 1.8 : 2.4)));
        let a, b, c, fRef, k;
        if (isBroiler) { a = 25; b = 0.85; c = 6; fRef = 1.7; k = 0.12; } 
        else { a = 58; b = 0.70; c = 8; fRef = 2.3; k = 0.08; }
        let baseDays = a * Math.pow(W, b) + c;
        const fAdj = 1 + k * (F - fRef);
        let days = Math.max(14, Math.round(baseDays * fAdj));
        const spread = days < 40 ? 1 : 2;
        return { min: Math.max(1, days - spread), center: days, max: days + spread };
    }
}

window.onCaptchaSuccess = function(token) {
    const calc = window.chickenCalcInstance;
    if (calc) calc.saveWithCaptcha(token);
};

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await loadConfig();
        initGoogleAuth();
        window.chickenCalcInstance = new ChickenCalc();
        await updateAuthUI();
        const sb = getSb();
        sb.auth.onAuthStateChange(async (_, session) => { await updateAuthUI(session); });
    } catch (error) {
        console.error('Init failed:', error);
    }
});

})();
