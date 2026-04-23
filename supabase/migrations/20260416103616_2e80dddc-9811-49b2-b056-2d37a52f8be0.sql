-- Fix upfront_credits to use correct multiplier (price_thb * 125)
UPDATE subscription_plans SET upfront_credits = price_thb * 125;