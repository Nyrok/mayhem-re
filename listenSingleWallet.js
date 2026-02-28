import {connection} from "./utils/rpc.js";
import {PublicKey} from "@solana/web3.js";

connection.onLogs(new PublicKey("7mKM8dMFBQacbj8gZbwunx4C9xRABcNzNgUWZDaz4mNQ"), (logs) => {
   console.log(logs.signature);
});