-- Schema for Bill Splitter application
-- Uses INTEGER PRIMARY KEY with AUTOINCREMENT-like behavior via UUIDs stored as TEXT

-- Homes table
CREATE TABLE homes (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Members table with ordering preserved via created_at
CREATE TABLE members (
  id TEXT PRIMARY KEY NOT NULL,
  home_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Named constraint: ensures every member belongs to a valid home
  CONSTRAINT fk_members_home FOREIGN KEY (home_id) REFERENCES homes(id) ON DELETE CASCADE
);

-- Bills table
CREATE TABLE bills (
  id TEXT PRIMARY KEY NOT NULL,
  home_id TEXT NOT NULL,
  title TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Named constraint: ensures bill amount is a positive integer
  CONSTRAINT chk_bills_total_positive CHECK (total_cents > 0),
  -- Named constraint: ensures every bill belongs to a valid home
  CONSTRAINT fk_bills_home FOREIGN KEY (home_id) REFERENCES homes(id) ON DELETE CASCADE
);

-- Shares table (each member's portion of a bill)
CREATE TABLE shares (
  id TEXT PRIMARY KEY NOT NULL,
  bill_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  paid_at TEXT,
  idempotency_key TEXT,
  -- Named constraint: ensures every share belongs to a valid bill
  CONSTRAINT fk_shares_bill FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
  -- Named constraint: ensures every share belongs to a valid member
  CONSTRAINT fk_shares_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  -- Named constraint: ensures share amount is non-negative
  CONSTRAINT chk_shares_amount_non_negative CHECK (amount_cents >= 0),
  -- Named constraint: ensures only one idempotency key per share (prevents double pay)
  CONSTRAINT uq_shares_idempotency UNIQUE (id, idempotency_key)
);

-- Index for fast lookups by home
CREATE INDEX idx_members_home_id ON members(home_id);
CREATE INDEX idx_bills_home_id ON bills(home_id);
CREATE INDEX idx_shares_bill_id ON shares(bill_id);
CREATE INDEX idx_shares_member_id ON shares(member_id);
