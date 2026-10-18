import { withSupabase } from 'npm:@supabase/server@^1'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
if (!SUPABASE_URL) {
  throw new Error('SUPABASE_URL is required')
}

const ALLOWED_ORIGIN = 'https://fayaa91000.github.io'
const BUCKET = 'payment-slips'
const MAX_FILE_BYTES = 5 * 1024 * 1024
// Bound multipart overhead as well as the file itself.
const MAX_BODY_BYTES = MAX_FILE_BYTES + 128 * 1024

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, apikey, x-client-info, content-type',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
}

function jsonResponse(
  req: Request,
  status: number,
  body: Record<string, unknown>,
): Response {
  const headers = new Headers(CORS_HEADERS)
  headers.set('Content-Type', 'application/json; charset=utf-8')

  // The fixed allow-origin header permits only the marketplace origin in
  // browsers. Origin is not treated as an authentication mechanism.
  return new Response(JSON.stringify(body), { status, headers })
}

function unauthorized(req: Request): Response {
  // Same response whether the order is absent or the access code is wrong.
  return jsonResponse(req, 401, { error: 'Unauthorized.' })
}

async function readBodyLimited(req: Request): Promise<Uint8Array> {
  if (!req.body) throw new Error('invalid_body')

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue

      total += value.byteLength
      if (total > MAX_BODY_BYTES) {
        await reader.cancel()
        throw new Error('body_too_large')
      }

      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function hasBytes(
  bytes: Uint8Array,
  offset: number,
  signature: number[],
): boolean {
  return signature.every((value, index) => bytes[offset + index] === value)
}

function detectMimeType(bytes: Uint8Array): string | null {
  // JPEG
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg'
  }

  // PNG
  if (
    bytes.length >= 8 &&
    hasBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return 'image/png'
  }

  // WebP: RIFF....WEBP
  if (
    bytes.length >= 12 &&
    hasBytes(bytes, 0, [0x52, 0x49, 0x46, 0x46]) &&
    hasBytes(bytes, 8, [0x57, 0x45, 0x42, 0x50])
  ) {
    return 'image/webp'
  }

  // PDF
  if (
    bytes.length >= 5 &&
    hasBytes(bytes, 0, [0x25, 0x50, 0x44, 0x46, 0x2d])
  ) {
    return 'application/pdf'
  }

  return null
}

function fileExtension(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/webp':
      return 'webp'
    case 'application/pdf':
      return 'pdf'
    default:
      throw new Error('unsupported_file')
  }
}

function safeDisplayName(originalName: string, extension: string): string {
  const baseName = originalName
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 200)

  return baseName || `payment-slip.${extension}`
}

function isOrderUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value)
}

function isFunctionGeneratedOrderPath(
  path: string,
  orderId: string,
): boolean {
  if (!path.startsWith(`${orderId}/`)) return false

  const segments = path.split('/')
  return segments.length === 2 &&
    segments.every((segment) =>
      segment.length > 0 && segment !== '.' && segment !== '..'
    )
}

export default {
  fetch: withSupabase({ auth: 'none' }, async (req, ctx) => {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    const origin = req.headers.get('origin')
    if (origin && origin !== ALLOWED_ORIGIN) {
      return jsonResponse(req, 403, { error: 'Request not allowed.' })
    }

    if (req.method !== 'POST') {
      return jsonResponse(req, 405, { error: 'Method not allowed.' })
    }

    try {
      const contentType = req.headers.get('content-type') ?? ''
      if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
        return jsonResponse(req, 400, { error: 'Invalid request.' })
      }

      const contentLength = Number(req.headers.get('content-length') ?? '0')
      if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
        return jsonResponse(req, 413, { error: 'Upload too large.' })
      }

      const rawBody = await readBodyLimited(req)
      const formReq = new Request(req.url, {
        method: 'POST',
        headers: req.headers,
        body: rawBody,
      })
      const form = await formReq.formData()

      const orderIdValue = form.get('order_id')
      const accessCodeValue = form.get('access_code')

      if (
        typeof orderIdValue !== 'string' ||
        !isOrderUuid(orderIdValue) ||
        typeof accessCodeValue !== 'string' ||
        accessCodeValue.length === 0 ||
        accessCodeValue.length > 1024
      ) {
        return unauthorized(req)
      }

      // Reuse the existing RPC and its SHA-256 guest_access_hash check.
      // The browser's publishable API key is forwarded only for this
      // non-privileged verification call; it is not treated as proof of
      // guest identity.
      const publishableKey = req.headers.get('apikey')
      if (!publishableKey) {
        return unauthorized(req)
      }

      const verificationResponse = await fetch(
        `${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/rpc/mbg_track_guest_order`,
        {
          method: 'POST',
          headers: {
            'apikey': publishableKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            target_order: orderIdValue,
            access_code: accessCodeValue,
          }),
        },
      )

      if (!verificationResponse.ok) {
        // Do not return Postgres/PostgREST details to the caller.
        return jsonResponse(req, 503, { error: 'Unable to process request.' })
      }

      const verificationRows: unknown = await verificationResponse.json()
        .catch(() => null)

      if (!Array.isArray(verificationRows) || verificationRows.length === 0) {
        return unauthorized(req)
      }

      // No privileged database or Storage request occurs until after the
      // existing guest RPC has returned a matching row.
      const paymentReferenceValue = form.get('payment_reference')
      const fileValue = form.get('payment_slip')

      if (
        typeof paymentReferenceValue !== 'string' ||
        paymentReferenceValue.trim().length === 0 ||
        paymentReferenceValue.trim().length > 500
      ) {
        return jsonResponse(req, 400, {
          error: 'Payment reference is required.',
        })
      }

      if (!(fileValue instanceof File) || fileValue.size === 0) {
        return jsonResponse(req, 400, { error: 'Payment slip is required.' })
      }

      if (fileValue.size > MAX_FILE_BYTES) {
        return jsonResponse(req, 413, { error: 'Upload too large.' })
      }

      const allowedMimeTypes = new Set([
        'image/jpeg',
        'image/png',
        'image/webp',
        'application/pdf',
      ])

      if (!allowedMimeTypes.has(fileValue.type)) {
        return jsonResponse(req, 400, { error: 'Unsupported file type.' })
      }

      const fileBytes = new Uint8Array(await fileValue.arrayBuffer())
      const detectedMimeType = detectMimeType(fileBytes)

      if (!detectedMimeType || detectedMimeType !== fileValue.type) {
        return jsonResponse(req, 400, { error: 'Unsupported file type.' })
      }

      const extension = fileExtension(detectedMimeType)
      const displayName = safeDisplayName(fileValue.name, extension)
      const newPath = `${orderIdValue}/${crypto.randomUUID()}.${extension}`

      // Privileged lookup is after successful guest verification. Retaining
      // the prior value lets the update be conditional against concurrent
      // replacements.
      const { data: priorOrder, error: priorReadError } = await ctx
        .supabaseAdmin
        .from('orders')
        .select('payment_slip_path')
        .eq('id', orderIdValue)
        .maybeSingle()

      if (priorReadError || !priorOrder) {
        return jsonResponse(req, 500, { error: 'Unable to process request.' })
      }

      const priorPath: string | null = priorOrder.payment_slip_path

      const { error: uploadError } = await ctx.supabaseAdmin.storage
        .from(BUCKET)
        .upload(newPath, fileBytes, {
          contentType: detectedMimeType,
          cacheControl: '0',
          upsert: false,
        })

      if (uploadError) {
        return jsonResponse(req, 500, { error: 'Unable to upload payment slip.' })
      }

      const updateValues = {
        payment_reference: paymentReferenceValue.trim(),
        payment_slip_path: newPath,
        payment_slip_name: displayName,
        payment_slip_type: detectedMimeType,
        payment_slip_uploaded_at: new Date().toISOString(),
      }

      // Compare-and-set the previous path so concurrent replacements cannot
      // overwrite one another based on stale state.
      const updateQuery = ctx.supabaseAdmin
        .from('orders')
        .update(updateValues)
        .eq('id', orderIdValue)

      const updateResult = priorPath === null
        ? await updateQuery.is('payment_slip_path', null).select('id')
        : await updateQuery.eq('payment_slip_path', priorPath).select('id')

      if (updateResult.error || !updateResult.data ||
        updateResult.data.length !== 1) {
        // Roll back the newly uploaded object if the row update failed.
        await ctx.supabaseAdmin.storage.from(BUCKET).remove([newPath])
        return jsonResponse(req, 409, {
          error: 'Unable to save payment slip. Please retry.',
        })
      }

      // Remove the previous object only after the new row pointer is saved.
      // Only paths created by this function under this order's folder are
      // removed; unknown legacy paths are left untouched rather than risking
      // deletion of another order's object.
      if (
        priorPath &&
        priorPath !== newPath &&
        isFunctionGeneratedOrderPath(priorPath, orderIdValue)
      ) {
        const { error: removeOldError } = await ctx.supabaseAdmin.storage
          .from(BUCKET)
          .remove([priorPath])

        if (removeOldError) {
          // Upload and database update succeeded; cleanup failure is not
          // exposed to the buyer. It can be investigated from server logs.
          console.warn('Previous payment slip cleanup failed.')
        }
      }

      return jsonResponse(req, 200, {
        ok: true,
        message: 'Payment slip uploaded. Payment still requires seller verification.',
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'body_too_large') {
        return jsonResponse(req, 413, { error: 'Upload too large.' })
      }

      return jsonResponse(req, 500, { error: 'Unable to process request.' })
    }
  }),
}
