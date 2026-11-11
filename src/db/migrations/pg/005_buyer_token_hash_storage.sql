-- Migration 005: Buyer Token Hash Storage & Indexing
-- Adds cryptographic SHA-256 hash storage for buyer_access_token
-- Ensures zero plaintext tokens at rest for new records while safely backfilling existing tokens.
-- Target: zarsev_test ONLY

ALTER TABLE rfqs 
ADD COLUMN IF NOT EXISTS buyer_access_token_hash VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_rfqs_token_hash 
ON rfqs(buyer_access_token_hash);

-- Backfill existing plaintext tokens by computing SHA-256 hex digest
UPDATE rfqs 
SET buyer_access_token_hash = encode(sha256(buyer_access_token::bytea), 'hex')
WHERE buyer_access_token IS NOT NULL 
  AND buyer_access_token_hash IS NULL;
