import 'dotenv/config'
import { createClient, createAccount } from 'genlayer-js'
import { testnetBradbury, studionet } from 'genlayer-js/chains'

const chainName = process.env.NEXT_PUBLIC_GENLAYER_CHAIN === 'studionet' ? 'studionet' : 'bradbury'
const chain = chainName === 'studionet' ? studionet : testnetBradbury

const address = process.argv[2]
if (!address) {
  console.error('Usage: node scripts/probe-contract.mjs <address>')
  process.exit(1)
}

const account = createAccount(process.env.DEPLOYER_PRIVATE_KEY)
const client = createClient({ chain, account })

try {
  const result = await client.readContract({
    address,
    functionName: 'get_all_channel_ids',
    args: [],
  })
  console.log('Contract is readable. get_all_channel_ids ->', result)
} catch (err) {
  console.error('Read failed:', err.message || err)
  process.exit(1)
}
