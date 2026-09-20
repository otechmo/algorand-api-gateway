import { createLazyProductionFetchHandler } from '../src/vercel-adapter.js'

const handler = createLazyProductionFetchHandler()

export const GET = handler
export const POST = handler
export const OPTIONS = handler
export const HEAD = handler
export const PUT = handler
export const PATCH = handler
export const DELETE = handler
