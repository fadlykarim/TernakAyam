-- Petok Predict Database Security
-- Row Level Security (RLS) Policies untuk keamanan data user

-- =====================================================
-- ENABLE ROW LEVEL SECURITY
-- =====================================================

-- Enable RLS pada semua tabel yang mengandung data user
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calculation_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_prices ENABLE ROW LEVEL SECURITY;

-- =====================================================
-- PROFILES TABLE POLICIES
-- =====================================================

-- Policy untuk read profile sendiri
CREATE POLICY "Users can view own profile" ON public.profiles
    FOR SELECT 
    USING ((SELECT auth.uid()) = id);

-- Policy untuk update profile sendiri
CREATE POLICY "Users can update own profile" ON public.profiles
    FOR UPDATE 
    USING ((SELECT auth.uid()) = id);

-- Policy untuk insert profile (biasanya via trigger)
CREATE POLICY "Users can insert own profile" ON public.profiles
    FOR INSERT 
    WITH CHECK ((SELECT auth.uid()) = id);

-- Policy untuk delete profile sendiri (jika diperlukan)
CREATE POLICY "Users can delete own profile" ON public.profiles
    FOR DELETE 
    USING ((SELECT auth.uid()) = id);

-- =====================================================
-- CALCULATION_HISTORY TABLE POLICIES
-- =====================================================

-- Policy untuk read calculation history sendiri
CREATE POLICY "Users can view own calculation history" ON public.calculation_history
    FOR SELECT 
    USING ((SELECT auth.uid()) = user_id);

-- Policy untuk insert calculation history sendiri
CREATE POLICY "Users can insert own calculation history" ON public.calculation_history
    FOR INSERT 
    WITH CHECK ((SELECT auth.uid()) = user_id);

-- Policy untuk update calculation history sendiri (edit notes, mark favorite, etc)
CREATE POLICY "Users can update own calculation history" ON public.calculation_history
    FOR UPDATE 
    USING ((SELECT auth.uid()) = user_id);

-- Policy untuk delete calculation history sendiri
CREATE POLICY "Users can delete own calculation history" ON public.calculation_history
    FOR DELETE 
    USING ((SELECT auth.uid()) = user_id);

-- =====================================================
-- USER_PREFERENCES TABLE POLICIES
-- =====================================================

-- Policy untuk read preferences sendiri
CREATE POLICY "Users can view own preferences" ON public.user_preferences
    FOR SELECT 
    USING ((SELECT auth.uid()) = user_id);

-- Policy untuk update preferences sendiri
CREATE POLICY "Users can update own preferences" ON public.user_preferences
    FOR UPDATE 
    USING ((SELECT auth.uid()) = user_id);

-- Policy untuk insert preferences sendiri
CREATE POLICY "Users can insert own preferences" ON public.user_preferences
    FOR INSERT 
    WITH CHECK ((SELECT auth.uid()) = user_id);

-- Policy untuk delete preferences sendiri
CREATE POLICY "Users can delete own preferences" ON public.user_preferences
    FOR DELETE 
    USING ((SELECT auth.uid()) = user_id);

-- =====================================================
-- MARKET_PRICES TABLE POLICIES (Public Read-Only)
-- =====================================================

-- Market prices bisa dibaca publik, tapi ubah hanya oleh service role
CREATE POLICY "Anyone can read market prices" ON public.market_prices
    FOR SELECT
    USING (true);

CREATE POLICY "Service role manages market prices" ON public.market_prices
    FOR INSERT
    WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role updates market prices" ON public.market_prices
    FOR UPDATE
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role deletes market prices" ON public.market_prices
    FOR DELETE
    USING (auth.role() = 'service_role');

-- =====================================================
-- ADDITIONAL SECURITY FUNCTIONS
-- =====================================================

-- Function untuk check apakah user adalah owner dari calculation
CREATE OR REPLACE FUNCTION public.is_calculation_owner(calculation_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
AS $$
    SELECT EXISTS (
        SELECT 1 
        FROM public.calculation_history 
        WHERE id = calculation_id AND user_id = auth.uid()
    );
$$;

-- Function untuk get user statistics (dengan security check)
CREATE OR REPLACE FUNCTION public.get_user_statistics(target_user_id uuid DEFAULT NULL)
RETURNS TABLE (
    total_calculations bigint,
    avg_profit numeric,
    max_profit integer,
    min_profit integer,
    favorite_count bigint,
    last_calculation timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
AS $$
    SELECT 
        COUNT(ch.id) as total_calculations,
        AVG(ch.keuntungan_bersih) as avg_profit,
        MAX(ch.keuntungan_bersih) as max_profit,
        MIN(ch.keuntungan_bersih) as min_profit,
        COUNT(CASE WHEN ch.is_favorite THEN 1 END) as favorite_count,
        MAX(ch.calculation_date) as last_calculation
    FROM public.calculation_history ch
    WHERE ch.user_id = COALESCE(target_user_id, auth.uid())
    AND ch.user_id = auth.uid(); -- Security: hanya bisa lihat data sendiri
$$;

-- =====================================================
-- GRANT PERMISSIONS
-- =====================================================

-- Grant permissions untuk authenticated users
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON public.profiles TO authenticated;
GRANT ALL ON public.calculation_history TO authenticated;
GRANT ALL ON public.user_preferences TO authenticated;
GRANT SELECT ON public.market_prices TO authenticated;

-- Grant permissions untuk anonymous users (jika diperlukan)
GRANT USAGE ON SCHEMA public TO anon;
GRANT SELECT ON public.market_prices TO anon;

-- Grant permissions pada sequences (untuk UUID generation, dll)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- Berikan hak eksekusi ke fungsi-fungsi publik
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;