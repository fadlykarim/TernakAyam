-- Petok Predict Database Schema
-- Untuk aplikasi kalkulator perhitungan ayam dengan Google Auth

-- =====================================================
-- TABEL 1: PROFILES (User Profile Data)
-- =====================================================
-- Tabel untuk menyimpan profil user setelah login Google
-- Automatically created via trigger saat user baru register

CREATE TABLE public.profiles (
    id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    email text NOT NULL,
    full_name text,
    avatar_url text,
    phone text,
    location text DEFAULT 'JABODETABEK',
    farm_name text, -- Nama peternakan user (optional)
    farm_type text CHECK (farm_type IN ('small', 'medium', 'large', 'custom')) DEFAULT 'small',
    advanced_mode boolean DEFAULT false,
    advanced_config jsonb DEFAULT '{}'::jsonb,
    created_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL,

    PRIMARY KEY (id),
    CONSTRAINT profiles_email_unique UNIQUE (email)
);

-- Index untuk performance
CREATE INDEX idx_profiles_email ON public.profiles(email);
CREATE INDEX idx_profiles_created_at ON public.profiles(created_at);
CREATE INDEX idx_profiles_location ON public.profiles(location);

-- =====================================================
-- TABEL 2: CALCULATION_HISTORY (History Kalkulasi)
-- =====================================================
-- Tabel untuk menyimpan history perhitungan kalkulasi ayam user
-- Setiap kali user melakukan kalkulasi, data disimpan disini

CREATE TABLE public.calculation_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Data input kalkulasi
    chicken_type text NOT NULL CHECK (chicken_type IN ('kampung', 'broiler')),
    populasi integer NOT NULL CHECK (populasi > 0),
    survival_rate decimal(5,4) NOT NULL CHECK (survival_rate > 0 AND survival_rate <= 1), -- 0.95 = 95%
    bobot_panen decimal(4,2) NOT NULL CHECK (bobot_panen > 0), -- kg per ekor
    harga_pakan_sak integer NOT NULL CHECK (harga_pakan_sak > 0), -- Rupiah per sak 50kg
    fcr decimal(3,2) NOT NULL CHECK (fcr > 0), -- Feed Conversion Ratio
    doc_price integer NOT NULL CHECK (doc_price > 0), -- Harga DOC per ekor dalam Rupiah
    
    -- Data harga pasar saat kalkulasi
    market_price integer NOT NULL CHECK (market_price > 0), -- Rupiah per kg
    market_price_source text, -- Source data harga (pasarsegar, japfabest, dll)
    
    -- Hasil kalkulasi (stored untuk history)
    ekor_panen integer NOT NULL,
    total_biaya_doc integer NOT NULL,
    total_biaya_pakan integer NOT NULL,
    total_biaya_tambahan integer NOT NULL, -- agregat vaksin, energi, tenaga kerja, overhead, transport
    total_biaya integer NOT NULL,
    total_pendapatan integer NOT NULL,
    keuntungan_bersih integer NOT NULL,
    margin_profit decimal(5,2), -- Persentase keuntungan
    is_advanced boolean DEFAULT false,
    basis text CHECK (basis IN ('live', 'carcass')) DEFAULT 'live',
    dressing_pct decimal(4,3),
    process_cost integer,
    wastage_pct decimal(4,3),
    shrinkage_pct decimal(4,3),
    harvest_age integer,
    vaccine_cost integer DEFAULT 0,
    heating_cost integer DEFAULT 0,
    labor_cost integer DEFAULT 0,
    overhead_cost integer DEFAULT 0,
    transport_cost integer DEFAULT 0,
    cost_per_kg numeric(12,2),
    break_even_price numeric(12,2),
    epef numeric(8,2),
    ai_notes text,
    ai_snapshot jsonb,
    
    -- Metadata
    calculation_date timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL,
    notes text, -- Catatan user (optional)
    is_favorite boolean DEFAULT false, -- User bisa mark kalkulasi favorit
    
    PRIMARY KEY (id)
);

-- Indexes untuk performance dan sorting
CREATE INDEX idx_calculation_history_user_id ON public.calculation_history(user_id);
CREATE INDEX idx_calculation_history_date ON public.calculation_history(calculation_date DESC);
CREATE INDEX idx_calculation_history_chicken_type ON public.calculation_history(chicken_type);
CREATE INDEX idx_calculation_history_profit ON public.calculation_history(keuntungan_bersih DESC);
CREATE INDEX idx_calculation_history_favorites ON public.calculation_history(user_id, is_favorite) WHERE is_favorite = true;
CREATE INDEX idx_calculation_history_user_date ON public.calculation_history(user_id, calculation_date DESC);

-- =====================================================
-- TABEL 3: USER_PREFERENCES (Preferensi User)
-- =====================================================
-- Tabel untuk menyimpan preferensi dan setting user

CREATE TABLE public.user_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Default values untuk kalkulasi
    default_chicken_type text CHECK (default_chicken_type IN ('kampung', 'broiler')) DEFAULT 'kampung',
    default_populasi integer DEFAULT 100,
    default_harga_pakan integer DEFAULT 400000,
    
    -- Notification preferences
    email_notifications boolean DEFAULT true,
    price_alert_enabled boolean DEFAULT false,
    price_alert_threshold integer, -- Alert jika harga di atas/bawah threshold
    
    -- Display preferences
    currency_format text DEFAULT 'IDR',
    date_format text DEFAULT 'DD/MM/YYYY',
    
    created_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL,
    
    PRIMARY KEY (id),
    UNIQUE(user_id) -- Satu user hanya punya satu preference record
);

-- =====================================================
-- TABEL 4: MARKET_PRICES (Data Harga Pasar)
-- =====================================================
-- Tabel untuk tracking harga pasar (optional, untuk analytics)

CREATE TABLE public.market_prices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    
    chicken_type text NOT NULL CHECK (chicken_type IN ('kampung', 'broiler')),
    price integer NOT NULL CHECK (price > 0), -- Rupiah per kg
    source text NOT NULL, -- pasarsegar, japfabest, dll
    source_url text,
    
    -- Metadata
    recorded_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL,
    is_valid boolean DEFAULT true, -- Untuk soft delete harga yang tidak valid
    
    PRIMARY KEY (id),
    CONSTRAINT market_prices_unique UNIQUE (chicken_type, recorded_at, source)
);

-- Indexes untuk market prices
CREATE INDEX idx_market_prices_type_date ON public.market_prices(chicken_type, recorded_at DESC);
CREATE INDEX idx_market_prices_source ON public.market_prices(source);

-- =====================================================
-- VIEWS untuk kemudahan query
-- =====================================================

-- View untuk statistik user
CREATE VIEW user_statistics AS
SELECT 
    p.id as user_id,
    p.full_name,
    p.email,
    COUNT(ch.id) as total_calculations,
    AVG(ch.keuntungan_bersih) as avg_profit,
    MAX(ch.keuntungan_bersih) as max_profit,
    MIN(ch.keuntungan_bersih) as min_profit,
    COUNT(CASE WHEN ch.is_favorite THEN 1 END) as favorite_calculations,
    MAX(ch.calculation_date) as last_calculation_date
FROM profiles p
LEFT JOIN calculation_history ch ON p.id = ch.user_id
GROUP BY p.id, p.full_name, p.email;

ALTER VIEW user_statistics SET (security_invoker = true);

-- View untuk recent calculations per user
CREATE VIEW recent_calculations AS
SELECT 
    ch.*,
    p.full_name as user_name
FROM calculation_history ch
JOIN profiles p ON ch.user_id = p.id
ORDER BY ch.calculation_date DESC;

ALTER VIEW recent_calculations SET (security_invoker = true);