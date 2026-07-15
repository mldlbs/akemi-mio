import { ReplayRunner } from '../golden/ReplayRunner'

const runner = new ReplayRunner({ goldenRoot: './docs/golden' })
const report = runner.run()
console.log(JSON.stringify(report, null, 2))
