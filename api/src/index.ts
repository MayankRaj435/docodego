import { Hono } from 'hono'

const app = new Hono<{ Bindings: Env }>()

app.notFound((c) => c.json({ error: 'Not found' }, 404))

app.onError((error, c) => {
  console.error('Unhandled API error', error)
  return c.json({ error: 'Internal server error' }, 500)
})

app.get('/api/health', (c) => c.json({ status: 'ok' }))

// ─── Part 1: Homes and Members ──────────────────────────────────────────

// List homes
app.get('/api/homes', async (c) => {
  const result = await c.env.DB.prepare(
    'SELECT id, name, created_at AS createdAt FROM homes ORDER BY created_at DESC, rowid DESC',
  ).all<{ id: string; name: string; createdAt: string }>()

  return c.json({ homes: result.results })
})

// Create home
app.post('/api/homes', async (c) => {
  let body: { name?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  if (!body || typeof body.name !== 'string' || body.name.trim() === '') {
    return c.json({ error: 'Name is required' }, 400)
  }

  const name = body.name.trim()
  const id = crypto.randomUUID()

  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)').bind(id, name).run()

  return c.json({ id, name }, 201)
})

// Get home by id
app.get('/api/homes/:homeId', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare(
    'SELECT id, name, created_at AS createdAt FROM homes WHERE id = ?',
  )
    .bind(homeId)
    .first<{ id: string; name: string; createdAt: string }>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  return c.json(home)
})

// List members of a home
app.get('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const result = await c.env.DB.prepare(
    'SELECT id, home_id AS homeId, name, created_at AS createdAt FROM members WHERE home_id = ? ORDER BY created_at ASC, rowid ASC',
  )
    .bind(homeId)
    .all<{ id: string; homeId: string; name: string; createdAt: string }>()

  return c.json({ members: result.results })
})

// Add a member to a home
app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')

  // Check the home exists
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  let body: { name?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  if (!body || typeof body.name !== 'string' || body.name.trim() === '') {
    return c.json({ error: 'Name is required' }, 400)
  }

  const name = body.name.trim()
  const id = crypto.randomUUID()

  await c.env.DB.prepare('INSERT INTO members (id, home_id, name) VALUES (?, ?, ?)')
    .bind(id, homeId, name)
    .run()

  return c.json({ id, homeId, name }, 201)
})

// ─── Part 2: Bills ──────────────────────────────────────────────────────

// List bills with their shares for a home
app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const billsResult = await c.env.DB.prepare(
    'SELECT id, home_id AS homeId, title, total_cents AS totalCents, created_at AS createdAt FROM bills WHERE home_id = ? ORDER BY created_at DESC, rowid DESC',
  )
    .bind(homeId)
    .all<{ id: string; homeId: string; title: string; totalCents: number; createdAt: string }>()

  const sharesResult = await c.env.DB.prepare(
    `SELECT
       s.id,
       s.bill_id AS billId,
       s.member_id AS memberId,
       m.name AS memberName,
       s.amount_cents AS amountCents,
       s.paid_at AS paidAt
     FROM shares s
     JOIN bills b ON s.bill_id = b.id
     JOIN members m ON s.member_id = m.id
     WHERE b.home_id = ?
     ORDER BY m.created_at ASC, m.rowid ASC`,
  )
    .bind(homeId)
    .all<{
      id: string
      billId: string
      memberId: string
      memberName: string
      amountCents: number
      paidAt: string | null
    }>()

  const sharesByBill = new Map<string, typeof sharesResult.results>()
  for (const share of sharesResult.results) {
    const list = sharesByBill.get(share.billId) || []
    list.push(share)
    sharesByBill.set(share.billId, list)
  }

  const bills = billsResult.results.map((bill) => ({
    ...bill,
    shares: sharesByBill.get(bill.id) || [],
  }))

  return c.json({ bills })
})

// Create and split a bill
app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')

  // Check the home exists
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  let body: { title?: unknown; totalCents?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const totalCents = body?.totalCents

  // Validate totalCents: must be a positive integer
  if (
    typeof totalCents !== 'number' ||
    !Number.isInteger(totalCents) ||
    !Number.isSafeInteger(totalCents) ||
    totalCents <= 0
  ) {
    return c.json({ error: 'totalCents must be a positive whole number' }, 422)
  }

  const title =
    typeof body?.title === 'string' && body.title.trim().length > 0 ? body.title.trim() : 'Bill'

  // Get all members of this home, ordered by creation
  const membersResult = await c.env.DB.prepare(
    'SELECT id, name FROM members WHERE home_id = ? ORDER BY created_at ASC, rowid ASC',
  )
    .bind(homeId)
    .all<{ id: string; name: string }>()

  const members = membersResult.results

  if (members.length === 0) {
    return c.json({ error: 'Home has no members' }, 422)
  }

  // Split the bill
  const memberCount = members.length
  const baseAmount = Math.floor(totalCents / memberCount)
  const remainder = totalCents % memberCount

  const billId = crypto.randomUUID()

  // Create shares - extra cents go to first members in order
  const shares: Array<{
    id: string
    memberId: string
    amountCents: number
    paidAt: null
  }> = []

  const shareStmts = members.map((member, index) => {
    const shareId = crypto.randomUUID()
    const amountCents = baseAmount + (index < remainder ? 1 : 0)

    shares.push({
      id: shareId,
      memberId: member.id,
      amountCents,
      paidAt: null,
    })

    return c.env.DB.prepare(
      'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
    ).bind(shareId, billId, member.id, amountCents)
  })

  // Insert bill and shares atomically in a single batch
  const billStmt = c.env.DB.prepare(
    'INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)',
  ).bind(billId, homeId, title, totalCents)

  await c.env.DB.batch([billStmt, ...shareStmts])

  return c.json(
    {
      id: billId,
      homeId,
      title,
      totalCents,
      shares,
    },
    201,
  )
})

// ─── Payments ───────────────────────────────────────────────────────────

app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')
  const idempotencyKey = c.req.header('Idempotency-Key')

  // Check idempotency key is present and not empty
  if (!idempotencyKey || idempotencyKey.trim() === '') {
    return c.json({ error: 'Idempotency-Key header is required' }, 400)
  }

  // Check the bill exists
  const bill = await c.env.DB.prepare('SELECT id FROM bills WHERE id = ?').bind(billId).first()

  if (!bill) {
    return c.json({ error: 'Bill not found' }, 404)
  }

  // Check the share exists and belongs to this bill
  const share = await c.env.DB.prepare(
    'SELECT id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ? AND bill_id = ?',
  )
    .bind(shareId, billId)
    .first<{
      id: string
      member_id: string
      amount_cents: number
      paid_at: string | null
      idempotency_key: string | null
    }>()

  if (!share) {
    return c.json({ error: 'Share not found' }, 404)
  }

  // If already paid, check idempotency
  if (share.paid_at !== null) {
    if (share.idempotency_key === idempotencyKey) {
      // Same key - idempotent response
      return c.json({
        id: share.id,
        memberId: share.member_id,
        amountCents: share.amount_cents,
        paidAt: share.paid_at,
      })
    }
    // Different key - conflict
    return c.json({ error: 'Share already paid with a different key' }, 409)
  }

  // Attempt to pay - use conditional UPDATE for concurrency safety
  const now = new Date().toISOString()
  const result = await c.env.DB.prepare(
    'UPDATE shares SET paid_at = ?, idempotency_key = ? WHERE id = ? AND bill_id = ? AND paid_at IS NULL',
  )
    .bind(now, idempotencyKey, shareId, billId)
    .run()

  if (result.meta.changes === 0) {
    // Another concurrent request beat us - re-read to check idempotency
    const updated = await c.env.DB.prepare(
      'SELECT id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ? AND bill_id = ?',
    )
      .bind(shareId, billId)
      .first<{
        id: string
        member_id: string
        amount_cents: number
        paid_at: string | null
        idempotency_key: string | null
      }>()

    if (updated?.idempotency_key === idempotencyKey) {
      return c.json({
        id: updated.id,
        memberId: updated.member_id,
        amountCents: updated.amount_cents,
        paidAt: updated.paid_at,
      })
    }

    return c.json({ error: 'Share already paid with a different key' }, 409)
  }

  return c.json({
    id: share.id,
    memberId: share.member_id,
    amountCents: share.amount_cents,
    paidAt: now,
  })
})

// ─── Balances ───────────────────────────────────────────────────────────

app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')

  // Check the home exists
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  // Get balances for all members, ordered by creation
  const result = await c.env.DB.prepare(
    `SELECT
       m.id AS memberId,
       m.name,
       COALESCE(SUM(CASE WHEN s.paid_at IS NULL AND s.id IS NOT NULL THEN s.amount_cents ELSE 0 END), 0) AS outstandingCents
     FROM members m
     LEFT JOIN (
       shares s
       JOIN bills b ON s.bill_id = b.id
     ) ON s.member_id = m.id AND b.home_id = m.home_id
     WHERE m.home_id = ?
     GROUP BY m.id, m.name
     ORDER BY m.created_at ASC, m.rowid ASC`,
  )
    .bind(homeId)
    .all<{ memberId: string; name: string; outstandingCents: number }>()

  return c.json({ balances: result.results })
})

export default app
