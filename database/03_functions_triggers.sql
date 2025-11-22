-- Petok Predict Database Functions & Triggers
-- Auto-create profile dan helper functions

-- =====================================================
-- FUNCTION: Auto-create profile saat user baru register
-- =====================================================

-- Function untuk membuat profile otomatis saat user baru register via Google Auth
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_full_name text;
BEGIN
    v_full_name := COALESCE(
        NEW.raw_user_meta_data->>'full_name',
        NEW.raw_user_meta_data->>'name',
        split_part(NEW.email, '@', 1)
    );

    BEGIN
        INSERT INTO public.profiles (
            id,
            email,
            full_name,
            avatar_url,
            created_at,
            updated_at
        )
        VALUES (
            NEW.id,
            NEW.email,
            v_full_name,
            NEW.raw_user_meta_data->>'avatar_url',
            timezone('utc', now()),
            timezone('utc', now())
        )
        ON CONFLICT (id) DO UPDATE
        SET
            email = EXCLUDED.email,
            full_name = COALESCE(EXCLUDED.full_name, public.profiles.full_name),
            avatar_url = COALESCE(EXCLUDED.avatar_url, public.profiles.avatar_url),
            updated_at = timezone('utc', now());

        INSERT INTO public.user_preferences (
            user_id,
            default_chicken_type,
            default_populasi,
            default_harga_pakan,
            email_notifications,
            created_at,
            updated_at
        )
        VALUES (
            NEW.id,
            'kampung',
            100,
            400000,
            true,
            timezone('utc', now()),
            timezone('utc', now())
        )
        ON CONFLICT (user_id) DO NOTHING;

        RAISE LOG 'Profile ensured for user % (ID: %)', NEW.email, NEW.id;
    EXCEPTION
        WHEN others THEN
            RAISE LOG 'Error creating profile for user % (ID: %): %', NEW.email, NEW.id, SQLERRM;
    END;

    RETURN NEW;
END;
$$;

-- =====================================================
-- TRIGGER: Execute handle_new_user saat ada user baru
-- =====================================================

-- Trigger yang akan berjalan setiap ada user baru di auth.users
CREATE OR REPLACE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();

-- =====================================================
-- FUNCTION: Manual profile creation helper (service role only)
-- =====================================================

CREATE OR REPLACE FUNCTION public.create_user_profile_manual(target_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    user_record auth.users%ROWTYPE;
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'Only service role may run create_user_profile_manual';
    END IF;

    SELECT * INTO user_record
    FROM auth.users
    WHERE id = target_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'User not found in auth.users with ID: %', target_user_id;
    END IF;

    PERFORM 1 FROM public.profiles WHERE id = target_user_id;
    IF FOUND THEN
        RETURN false;
    END IF;

    INSERT INTO public.profiles (
        id,
        email,
        full_name,
        avatar_url,
        created_at,
        updated_at
    )
    VALUES (
        user_record.id,
        user_record.email,
        COALESCE(
            user_record.raw_user_meta_data->>'full_name',
            user_record.raw_user_meta_data->>'name',
            split_part(user_record.email, '@', 1)
        ),
        user_record.raw_user_meta_data->>'avatar_url',
        timezone('utc', now()),
        timezone('utc', now())
    )
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.user_preferences (
        user_id,
        default_chicken_type,
        default_populasi,
        default_harga_pakan,
        email_notifications,
        created_at,
        updated_at
    )
    VALUES (
        user_record.id,
        'kampung',
        100,
        400000,
        true,
        timezone('utc', now()),
        timezone('utc', now())
    )
    ON CONFLICT (user_id) DO NOTHING;

    RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_user_profile_manual(uuid) TO service_role;

-- =====================================================
-- FUNCTION: Update updated_at timestamp
-- =====================================================

-- Function untuk auto-update updated_at field
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    NEW.updated_at = timezone('utc', now());
    RETURN NEW;
END;
$$;

-- =====================================================
-- TRIGGERS: Auto-update updated_at pada tabel yang perlu
-- =====================================================

-- Trigger untuk profiles table
CREATE OR REPLACE TRIGGER profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

-- Trigger untuk user_preferences table
CREATE OR REPLACE TRIGGER user_preferences_updated_at
    BEFORE UPDATE ON public.user_preferences
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

-- Trigger untuk calculation_history table
CREATE OR REPLACE TRIGGER calculation_history_updated_at
    BEFORE UPDATE ON public.calculation_history
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

-- =====================================================
-- FUNCTION: Save calculation to history
-- =====================================================

-- Function untuk save calculation dengan validation
CREATE OR REPLACE FUNCTION public.save_calculation(
    p_chicken_type text,
    p_populasi integer,
    p_survival_rate decimal,
    p_bobot_panen decimal,
    p_harga_pakan_sak integer,
    p_fcr decimal,
    p_doc_price integer,
    p_market_price integer,
    p_ekor_panen integer,
    p_total_biaya_doc integer,
    p_total_biaya_pakan integer,
    p_total_biaya_tambahan integer,
    p_total_biaya integer,
    p_total_pendapatan integer,
    p_keuntungan_bersih integer,
    p_market_price_source text DEFAULT NULL,
    p_notes text DEFAULT NULL,
    p_is_advanced boolean DEFAULT false,
    p_basis text DEFAULT 'live',
    p_dressing_pct decimal DEFAULT NULL,
    p_process_cost integer DEFAULT NULL,
    p_wastage_pct decimal DEFAULT NULL,
    p_shrinkage_pct decimal DEFAULT NULL,
    p_harvest_age integer DEFAULT NULL,
    p_vaccine_cost integer DEFAULT NULL,
    p_heating_cost integer DEFAULT NULL,
    p_labor_cost integer DEFAULT NULL,
    p_overhead_cost integer DEFAULT NULL,
    p_transport_cost integer DEFAULT NULL,
    p_cost_per_kg numeric DEFAULT NULL,
    p_break_even_price numeric DEFAULT NULL,
    p_epef numeric DEFAULT NULL,
    p_ai_notes text DEFAULT NULL,
    p_ai_snapshot jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    calculation_id uuid;
    margin_profit decimal;
BEGIN
    -- Validasi user sudah login
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'User must be authenticated';
    END IF;

    -- Hitung margin profit
    IF p_total_pendapatan > 0 THEN
        margin_profit := (p_keuntungan_bersih::decimal / p_total_pendapatan::decimal) * 100;
    ELSE
        margin_profit := 0;
    END IF;

    -- Insert calculation history
    INSERT INTO public.calculation_history (
        user_id,
        chicken_type,
        populasi,
        survival_rate,
        bobot_panen,
        harga_pakan_sak,
        fcr,
        doc_price,
        market_price,
        market_price_source,
        ekor_panen,
        total_biaya_doc,
        total_biaya_pakan,
        total_biaya_tambahan,
        total_biaya,
        total_pendapatan,
        keuntungan_bersih,
        margin_profit,
        notes,
        calculation_date,
        is_advanced,
        basis,
        dressing_pct,
        process_cost,
        wastage_pct,
        shrinkage_pct,
        harvest_age,
        vaccine_cost,
        heating_cost,
        labor_cost,
        overhead_cost,
        transport_cost,
        cost_per_kg,
        break_even_price,
        epef,
        ai_notes,
        ai_snapshot
    )
    VALUES (
        auth.uid(),
        p_chicken_type,
        p_populasi,
        p_survival_rate,
        p_bobot_panen,
        p_harga_pakan_sak,
        p_fcr,
        p_doc_price,
        p_market_price,
        p_market_price_source,
        p_ekor_panen,
        p_total_biaya_doc,
        p_total_biaya_pakan,
        p_total_biaya_tambahan,
        p_total_biaya,
        p_total_pendapatan,
        p_keuntungan_bersih,
        margin_profit,
        p_notes,
        timezone('utc', now()),
        COALESCE(p_is_advanced, false),
        CASE WHEN p_basis IN ('live', 'carcass') THEN p_basis ELSE 'live' END,
        p_dressing_pct,
        p_process_cost,
        p_wastage_pct,
        p_shrinkage_pct,
        p_harvest_age,
        COALESCE(p_vaccine_cost, 0),
        COALESCE(p_heating_cost, 0),
        COALESCE(p_labor_cost, 0),
        COALESCE(p_overhead_cost, 0),
        COALESCE(p_transport_cost, 0),
        p_cost_per_kg,
        p_break_even_price,
        p_epef,
        p_ai_notes,
        p_ai_snapshot
    )
    RETURNING id INTO calculation_id;

    RETURN calculation_id;
END;
$$;

-- =====================================================
-- FUNCTION: Get user's recent calculations
-- =====================================================

CREATE OR REPLACE FUNCTION public.get_recent_calculations(
    limit_count integer DEFAULT 10,
    offset_count integer DEFAULT 0
)
RETURNS TABLE (
    id uuid,
    chicken_type text,
    populasi integer,
    keuntungan_bersih integer,
    margin_profit decimal,
    calculation_date timestamptz,
    is_favorite boolean,
    notes text,
    is_advanced boolean,
    basis text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
AS $$
    SELECT 
        ch.id,
        ch.chicken_type,
        ch.populasi,
        ch.keuntungan_bersih,
        ch.margin_profit,
        ch.calculation_date,
        ch.is_favorite,
    ch.notes,
    ch.is_advanced,
    ch.basis
    FROM public.calculation_history ch
    WHERE ch.user_id = auth.uid()
    ORDER BY ch.is_favorite DESC, ch.calculation_date DESC
    LIMIT limit_count
    OFFSET offset_count;
$$;

-- =====================================================
-- FUNCTION: Get user's favorite calculations
-- =====================================================

CREATE OR REPLACE FUNCTION public.get_favorite_calculations()
RETURNS TABLE (
    id uuid,
    chicken_type text,
    populasi integer,
    keuntungan_bersih integer,
    margin_profit decimal,
    calculation_date timestamptz,
    notes text,
    is_advanced boolean,
    basis text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
AS $$
    SELECT 
        ch.id,
        ch.chicken_type,
        ch.populasi,
        ch.keuntungan_bersih,
        ch.margin_profit,
        ch.calculation_date,
    ch.notes,
    ch.is_advanced,
    ch.basis
    FROM public.calculation_history ch
    WHERE ch.user_id = auth.uid()
      AND ch.is_favorite = true
    ORDER BY ch.calculation_date DESC;
$$;

-- =====================================================
-- FUNCTION: Toggle favorite calculation
-- =====================================================

CREATE OR REPLACE FUNCTION public.toggle_favorite_calculation(
    calculation_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    current_favorite boolean;
    new_favorite boolean;
BEGIN
    IF NOT public.is_calculation_owner(calculation_id) THEN
        RAISE EXCEPTION 'Not authorized to modify this calculation';
    END IF;

    SELECT is_favorite INTO current_favorite
    FROM public.calculation_history
    WHERE id = calculation_id AND user_id = auth.uid();

    new_favorite := NOT COALESCE(current_favorite, false);

    UPDATE public.calculation_history
    SET is_favorite = new_favorite,
        updated_at = timezone('utc', now())
    WHERE id = calculation_id AND user_id = auth.uid();

    RETURN new_favorite;
END;
$$;

-- =====================================================
-- FUNCTION: Delete calculation
-- =====================================================

CREATE OR REPLACE FUNCTION public.delete_calculation(
    calculation_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    IF NOT public.is_calculation_owner(calculation_id) THEN
        RAISE EXCEPTION 'Not authorized to delete this calculation';
    END IF;

    DELETE FROM public.calculation_history
    WHERE id = calculation_id AND user_id = auth.uid();

    RETURN true;
END;
$$;

-- =====================================================
-- FUNCTION: Update user profile
-- =====================================================

CREATE OR REPLACE FUNCTION public.update_user_profile(
    p_full_name text DEFAULT NULL,
    p_phone text DEFAULT NULL,
    p_location text DEFAULT NULL,
    p_farm_name text DEFAULT NULL,
    p_farm_type text DEFAULT NULL,
    p_advanced_mode boolean DEFAULT NULL,
    p_advanced_config jsonb DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'User must be authenticated';
    END IF;

    UPDATE public.profiles
    SET
        full_name = COALESCE(p_full_name, full_name),
        phone = COALESCE(p_phone, phone),
        location = COALESCE(p_location, location),
        farm_name = COALESCE(p_farm_name, farm_name),
        farm_type = COALESCE(p_farm_type, farm_type),
        advanced_mode = COALESCE(p_advanced_mode, advanced_mode),
        advanced_config = COALESCE(p_advanced_config, advanced_config),
        updated_at = timezone('utc', now())
    WHERE id = auth.uid();

    RETURN true;
END;
$$;