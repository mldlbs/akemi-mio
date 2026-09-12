import { ReplayRunner } from '@akemi-mio/reasoning/golden/ReplayRunner'

const runner = new ReplayRunner({ goldenRoot: './docs/golden' })
const report = runner.run()
console.log(JSON.stringify(report, null, 2))
