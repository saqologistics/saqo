-- Payment mutations go through the SAQO server, which authenticates and authorizes them.
BEGIN;

REVOKE EXECUTE ON FUNCTION
  public.saqo_ensure_wallet(text),
  public.saqo_credit_wallet(text, numeric, text, text, text, text, text, uuid, text, text, jsonb),
  public.saqo_debit_wallet(text, numeric, text, text, text, text, text, uuid, text, text, jsonb),
  public.saqo_adjust_wallet(text, text, numeric, text, text, text, text),
  public.saqo_process_refund(text, uuid, text, text, numeric, text, text, text, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.saqo_ensure_wallet(text),
  public.saqo_credit_wallet(text, numeric, text, text, text, text, text, uuid, text, text, jsonb),
  public.saqo_debit_wallet(text, numeric, text, text, text, text, text, uuid, text, text, jsonb),
  public.saqo_adjust_wallet(text, text, numeric, text, text, text, text),
  public.saqo_process_refund(text, uuid, text, text, numeric, text, text, text, text)
TO service_role;

COMMIT;
