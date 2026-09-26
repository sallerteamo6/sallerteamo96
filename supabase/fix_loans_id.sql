-- Fix loans table: add default ID generation
ALTER TABLE public.loans ALTER COLUMN id SET DEFAULT 'LOAN_' || upper(encode(gen_random_bytes(8), 'hex')) || '_' || floor(extract(epoch from now()) * 1000)::text;

-- Verify
INSERT INTO public.loans (uid, account, amount, days, rate, interest, status)
VALUES (100017, 'test', 100, 7, 1, 1, 'pending')
RETURNING id;