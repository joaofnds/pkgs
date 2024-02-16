# Throughput

measure the throughput of anything

```javascript
import { createServer } from "http";
import { Throughput } from "throughput";

const throughput = new Throughput(60, 1000);

function listener(req, res) {
	throughput.hit();
	console.log(`${throughput.perSecond()} requests/s`);
	res.end();
}

createServer(listener)
	.listen(8080, () => throughput.start())
	.on("close", () => throughput.stop());
```

If you run this server and test it with [vegeta](https://github.com/tsenart/vegeta):

```sh
vegeta attack -duration=5m -rate=1000/1s <<< "GET http://localhost:8080/" > /dev/null
```

You will see that the RPS will start to ramp up and stabilize at 1000 requests/s after a minute (60 probes with a 1000ms interval between each)
