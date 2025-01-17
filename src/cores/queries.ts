/**
 * this file is copied from project `v1-interface`
 * 
 * @author Phroi
 * @reference https://github.com/ickb/v1-interface/blob/master/src/queries.ts
 */

import { helpers } from "@ckb-lumos/lumos";
import { queryOptions } from "@tanstack/react-query";
import {
    CKB,
    ConfigAdapter,
    I8Cell,
    I8Header,
    Uint128,
    capacitySifter,
    ckbDelta,
    headerDeps,
    hex,
    maturityDiscriminator,
    max,
    scriptEq,
    shuffle,
    since,
} from "@ickb/lumos-utils";
import {
    addWithdrawalRequestGroups,
    ckb2Ickb,
    ickbLogicScript,
    ickbPoolSifter,
    ickbSifter,
    ickbUdtType,
    limitOrderScript,
    orderSifter,
    ownedOwnerScript,
    ReceiptData,
} from "@ickb/v1-core";
import {
    IckbDirection,
    maturityWaitTime,
    maxWaitTime,
    MyReceipt,
    MyMaturity,
    txInfoFrom,
    RecentOrder,
} from "./utils";
import { addChange, base, convert } from "./transaction";
import type { Cell, Header, HexNumber, Transaction } from "@ckb-lumos/base";
import { parseAbsoluteEpochSince } from "@ckb-lumos/base/lib/since";
import { getWalletConfig, type WalletConfig } from "./config";
import { ccc } from "@ckb-ccc/connector-react";

const depositUsedCapacity = BigInt(82) * CKB;

export function l1StateOptions(isFrozen: boolean) {
    const walletConfig = getWalletConfig();

    return queryOptions({
        retry: true,
        refetchInterval:30000,
        refetchOnWindowFocus: true,
        refetchOnMount: true,
        refetchIntervalInBackground: false,
        // staleTime: 10000,
        queryKey: ["l1State"],
        queryFn: async () => {
            try {
                const data = await getL1State(walletConfig);
                console.log(data);
                return data
            } catch (e) {
                console.log(e);
                throw e;
            }
        },
        placeholderData: {
            ickbUdtPoolBalance: BigInt(-1),
            ickbDaoBalance: BigInt(-1),
            myOrders: [],
            myReceipts: [],
            myMaturity: [],
            ckbBalance: BigInt(-1),
            ickbRealUdtBalance: BigInt(0),
            ickbPendingBalance: BigInt(0),
            ckbPendingBalance: BigInt(0),
            ckbAvailable: BigInt(6) * CKB * CKB,
            tipHeader: headerPlaceholder,
            txBuilder: () => txInfoFrom({}),
            hasMatchable: false,
        },
        enabled: !isFrozen,
    });
}

async function getL1State(walletConfig: WalletConfig) {
    const { rpc, config, expander } = walletConfig;
    console.log(11111)
    const mixedCells = await getMixedCells(walletConfig);

    // Prefetch feeRate and tipHeader
    const feeRatePromise = rpc.getFeeRate(BigInt(1));
    const tipHeaderPromise = rpc.getTipHeader();

    // Prefetch headers
    const wanted = new Set<HexNumber>();
    const deferredGetHeader = (blockNumber: string) => {
        wanted.add(blockNumber);
        return headerPlaceholder;
    };
    ickbSifter(mixedCells, expander, deferredGetHeader, config);
    const headersPromise = getHeadersByNumber(wanted, walletConfig);

    // Prefetch txs outputs
    const wantedTxsOutputs = new Set<string>();
    const deferredGetTxsOutputs = (txHash: string) => {
        wantedTxsOutputs.add(txHash);
        return [];
    };
    orderSifter(mixedCells, expander, deferredGetTxsOutputs, config);
    const txsOutputsPromise = getTxsOutputs(wantedTxsOutputs, walletConfig);

    // Do potentially costly operations
    const { capacities, notCapacities } = capacitySifter(mixedCells, expander);

    // Await for headers
    const headers = await headersPromise;
    // Sift through iCKB related cells
    const {
        udts,
        receipts,
        withdrawalRequestGroups,
        ickbPool: pool,
        notIckbs,
    } = ickbSifter(
        notCapacities,
        expander,
        (blockNumber) => headers.get(blockNumber)!,
        config,
    );
    // Calculate iCKB pool total balance
    const ickbDaoBalance = pool.map(cell => BigInt(cell.cellOutput.capacity) - depositUsedCapacity).reduce((a, b) => a + b, BigInt(0));

    const tipHeader = I8Header.from(await tipHeaderPromise);
    // Partition between ripe and non ripe withdrawal requests
    const { mature, notMature } = maturityDiscriminator(
        withdrawalRequestGroups,
        (g) => g.ownedWithdrawalRequest.cellOutput.type![since],
        tipHeader,
    );

    // min lock: 1/4 epoch (~ 1 hour)
    const minLock = { length: 4, index: 1, number: 0 };
    // Sort the ickbPool based on the tip header
    let ickbPool = ickbPoolSifter(pool, tipHeader, minLock);
    // Take a random convenient subset of max 40 deposits
    if (ickbPool.length > 40) {
        const n = max(Math.round(ickbPool.length / 180), 40);
        ickbPool = shuffle(ickbPool.slice(0, n).map((d, i) => ({ d, i })))
            .slice(0, 40)
            .sort((a, b) => a.i - b.i)
            .map((a) => a.d);
    }

    // Await for txsOutputs
    const txsOutputs = await txsOutputsPromise;

    // Sift through Orders
    const { myOrders } = orderSifter(
        notIckbs,
        expander,
        (txHash) => txsOutputs.get(txHash) ?? [],
        config,
    );

    const hasMatchable = myOrders.some((o) => o.info.isMatchable);

    const txConsumesIntermediate =
        mature.length > 0 || receipts.length > 0 || myOrders.length > 0;

    // Calculate balances and baseTx
    const { tx: baseTx, info: baseInfo } = base({
        capacities,
        udts,
        myOrders,
        receipts,
        wrGroups: mature,
    });

    const myReceipts = convertReceipts(receipts, config);
    // const ickbUdtBalance = ickbDelta(baseTx, config);

    let ckbBalance = ckbDelta(baseTx, config);
    const ckbAvailable = max((ckbBalance / CKB - BigInt(1000)) * CKB, BigInt(0));
    let info = baseInfo;
    let wrWaitTime = "0 minutes";
    if (notMature.length > 0) {
        ckbBalance += ckbDelta(
            addWithdrawalRequestGroups(helpers.TransactionSkeleton(), notMature),
            config,
        );

        wrWaitTime = maxWaitTime(
            notMature.map((g) =>
                parseAbsoluteEpochSince(
                    g.ownedWithdrawalRequest.cellOutput.type![since],
                ),
            ),
            tipHeader,
        );

        info = Object.freeze(
            [
                `Excluding ${notMature.length} Withdrawal Request${notMature.length > 1 ? "s" : ""}` +
                ` with maturity in ${wrWaitTime}`,
            ].concat(info),
        );
    }

    const feeRate = BigInt(Number(await feeRatePromise) + 1000);
    const txBuilder = (direction: IckbDirection, amount: bigint) => {
        const txInfo = txInfoFrom({ tx: baseTx, info });

        if (direction === "ckb2ickb" || direction === "ickb2ckb") {
            const isCkb2Udt = direction === "ckb2ickb";
            if (amount > BigInt(0)) {
                return convert(
                    txInfo,
                    isCkb2Udt,
                    amount,
                    ickbPool,
                    tipHeader,
                    feeRate,
                    walletConfig,
                );
            }
        }

        if (txConsumesIntermediate || direction === "melt") {
            return addChange(txInfo, feeRate, walletConfig);
        }

        return txInfoFrom({ info, error: "Nothing to convert" });
    };

    // Calculate total and real ickb udt liquidity
    const { poolBalance: ickbUdtPoolBalance, userBalance: ickbRealUdtBalance } = await getTotalUdtCapacity(walletConfig);

    // Calculate pending udt and ckb, including matured
    let ckbPendingBalance = BigInt(0);
    myOrders.forEach((item) => {
        if (item.info.isUdt2Ckb && item.info.absTotal === item.info.absProgress) {
            ckbPendingBalance += item.info.ckbAmount;
        }
    });
    const myMaturity: MyMaturity[] = [];
    mature.forEach((item) => {
        const maturedCkb = BigInt(parseInt(item.ownedWithdrawalRequest.cellOutput.capacity, 16));
        ckbPendingBalance += maturedCkb;
        myMaturity.push({
            daoCell: item.owner,
            ckbAmount: maturedCkb,
            waitTime: "matured",
        })
    });
    let ickbPendingBalance = BigInt(0);
    myOrders.forEach((item) => {
        if (item.info.isCkb2Udt && item.info.absTotal === item.info.absProgress) {
            ickbPendingBalance += item.info.udtAmount;
        }
    });

    // Calculate not matured
    notMature.forEach((item) => {
        const notMaturedCkb = BigInt(parseInt(item.ownedWithdrawalRequest.cellOutput.capacity, 16));
        const e = parseAbsoluteEpochSince(
            item.ownedWithdrawalRequest.cellOutput.type![since],
        );
        myMaturity.push({
            daoCell: item.owner,
            ckbAmount: notMaturedCkb,
            waitTime: maturityWaitTime(e, tipHeader)
        });
    });

    return {
        ickbDaoBalance,
        ickbUdtPoolBalance,
        myOrders,
        myReceipts,
        myMaturity,
        ckbBalance,
        ickbRealUdtBalance,
        ckbAvailable,
        ickbPendingBalance,
        ckbPendingBalance,
        tipHeader,
        txBuilder,
        hasMatchable,
    };
}

function convertReceipts(receipts: I8Cell[], config: ConfigAdapter): MyReceipt[] {
    const ickbLogic = ickbLogicScript(config);
    return receipts.filter((c) => {
        return scriptEq(c.cellOutput.type, ickbLogic);
    }).map((c) => {
        const header = c.cellOutput.type![headerDeps][0];
        const { depositQuantity: quantity, depositAmount: amount } =
            ReceiptData.unpack(c.data);
        const ickbValue = ckb2Ickb(amount, header, false) * BigInt(quantity);
        return {
            receiptCell: c,
            depositQuantity: quantity,
            depositAmount: amount,
            ckbAmount: amount * BigInt(quantity),
            ickbAmount: ickbValue,
        }
    });
}

async function getTotalUdtCapacity(walletConfig: WalletConfig): Promise<{
    poolBalance: bigint;
    userBalance: bigint;
}> {
    const { rpc, config, accountLock } = walletConfig;
    const udtType = ickbUdtType(config);
    console.log("udtType = ", udtType);
    let cursor = undefined;
    let udtCapacity = BigInt(0);
    let userUdtCapacity = BigInt(0);
    while (true) {
        //@ts-expect-error 未指定type
        const result = await rpc.getCells({
            script: udtType,
            scriptType: "type",
            scriptSearchMode: "exact",
            withData: true,
        }, "desc", BigInt(50), cursor);
        if (result.objects.length === 0) {
            break;
        }
        cursor = result.lastCursor;
        //@ts-expect-error 未指定type
        result.objects.forEach((cell: { outputData; output; }) => {
            if (scriptEq(cell.output.lock, accountLock)) {
                userUdtCapacity += Uint128.unpack(cell.outputData.slice(0, 2 + 16 * 2));
            }
            udtCapacity += Uint128.unpack(cell.outputData.slice(0, 2 + 16 * 2));
        })
    }
    return {
        poolBalance: udtCapacity,
        userBalance: userUdtCapacity,
    };
}

async function getMixedCells(walletConfig: WalletConfig) {
    const { accountLock, config, rpc } = walletConfig;

    return Object.freeze(
        (
            await Promise.all(
                [
                    accountLock,
                    ickbLogicScript(config),
                    ownedOwnerScript(config),
                    limitOrderScript(config),
                ].map((lock) => rpc.getCellsByLock(lock, "desc", "max")),
            )
        ).flat(),
    );
}

async function getTxsOutputs(
    txHashes: Set<string>,
    walletConfig: WalletConfig,
) {
    const { chain, rpc, queryClient } = walletConfig;

    const known: Readonly<Map<HexNumber, Readonly<Cell[]>>> =
        queryClient.getQueryData([chain, "txsOutputs"]) ?? Object.freeze(new Map());

    const result = new Map<string, Readonly<Cell[]>>();
    const batch = rpc.createBatchRequest();
    for (const txHash of Array.from(txHashes)) {
        const outputs = known.get(txHash);
        if (outputs !== undefined) {
            result.set(txHash, outputs);
            continue;
        }
        batch.add("getTransaction", txHash);
    }

    if (batch.length === 0) {
        return known;
    }

    for (const tx of (await batch.exec()).map(
        ({ transaction: tx }: { transaction: Transaction }) => tx,
    )) {
        result.set(
            tx.hash!,
            Object.freeze(
                tx.outputs.map(({ lock, type, capacity }, index) =>
                    Object.freeze(<Cell>{
                        cellOutput: Object.freeze({
                            lock: Object.freeze(lock),
                            type: Object.freeze(type),
                            capacity: Object.freeze(capacity),
                        }),
                        data: Object.freeze(tx.outputsData[index] ?? "0x"),
                        outPoint: Object.freeze({
                            txHash: tx.hash!,
                            index: hex(index),
                        }),
                    }),
                ),
            ),
        );
    }

    const frozenResult = Object.freeze(result);
    queryClient.setQueryData([chain, "txsOutputs"], frozenResult);
    return frozenResult;
}

export async function getHeadersByNumber(
    wanted: Set<HexNumber>,
    walletConfig: WalletConfig,
) {
    const { chain, rpc, queryClient } = walletConfig;

    const known: Readonly<Map<HexNumber, Readonly<I8Header>>> =
        queryClient.getQueryData([chain, "headers"]) ?? Object.freeze(new Map());

    const result = new Map<HexNumber, Readonly<I8Header>>();
    const batch = rpc.createBatchRequest();
    for (const blockNum of Array.from(wanted)) {
        const h = known.get(blockNum);
        if (h !== undefined) {
            result.set(blockNum, h);
            continue;
        }
        batch.add("getHeaderByNumber", blockNum);
    }

    if (batch.length === 0) {
        return known;
    }

    for (const h of (await batch.exec()) as Header[]) {
        result.set(h.number, I8Header.from(h));
    }

    const frozenResult = Object.freeze(result);
    queryClient.setQueryData([chain, "headers"], frozenResult);

    return frozenResult;
}

export const headerPlaceholder = I8Header.from({
    compactTarget: "0x1a08a97e",
    parentHash:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
    transactionsRoot:
        "0x31bf3fdf4bc16d6ea195dbae808e2b9a8eca6941d589f6959b1d070d51ac28f7",
    proposalsHash:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
    extraHash:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
    dao: "0x8874337e541ea12e0000c16ff286230029bfa3320800000000710b00c0fefe06",
    epoch: "0x0",
    hash: "0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5",
    nonce: "0x0",
    number: "0x0",
    timestamp: "0x16e70e6985c",
    version: "0x0",
});

export async function* getRecentIckbOrders(signer: ccc.Signer, config: ConfigAdapter) {
    const limitOrder = limitOrderScript(config);
    const udtType = ickbUdtType(config);
    const ickbLogicType = ickbLogicScript(config);
    const ownedOwner = ownedOwnerScript(config);
    const unoccupiedCkb = (tx: ccc.Transaction, outputIndex: number) => {
        const dataBytes = ccc.bytesFrom(tx.outputsData[outputIndex]);
        const occupiedCkb = BigInt(tx.outputs[outputIndex].occupiedSize + dataBytes.length) * CKB;
        const ckbCapacity = tx.outputs[outputIndex].capacity;
        return ckbCapacity - occupiedCkb;
    };
    let recentOrders: RecentOrder[] = [];
    // Find all dao mint
    for await (const tx of signer.findTransactions({
        script: ickbLogicType,
    }, true, "desc")) {
        const header = await signer.client.getHeaderByNumber(tx.blockNumber);
        if (!header) {
            continue;
        }
        const inOutput = tx.cells.find(({ isInput }) => !isInput);
        if (inOutput) {
            const receiptCell = await signer.client.getCell({
                txHash: tx.txHash,
                index: inOutput.cellIndex
            });
            if (!receiptCell) {
                continue;
            }
            const receiptData = ReceiptData.unpack(receiptCell.outputData);
            const ckbAmount = receiptData.depositAmount * BigInt(receiptData.depositQuantity);
            const timestamp = header.timestamp;
            const order: RecentOrder = {
                timestamp,
                operation: "dao_deposit",
                amount: ckbAmount,
                unit: "CKB",
            }
            recentOrders.push(order);
        }
    }
    // Find all dao withdraw
    for await (const tx of signer.findTransactions({
        script: ownedOwner
    }, true, "desc")) {
        const header = await signer.client.getHeaderByNumber(tx.blockNumber);
        if (!header) {
            continue;
        }
        const inOutput = tx.cells.find(({ isInput }) => !isInput);
        if (inOutput) {
            const result = await signer.client.getTransaction(tx.txHash);
            if (!result) {
                continue;
            }
            const { transaction } = result;
            const daoWithdrawIndex = transaction.outputs.findIndex(cell => scriptEq(cell.lock, ownedOwner));
            if (daoWithdrawIndex === -1) {
                continue;
            }
            const ckbAmount = unoccupiedCkb(transaction, daoWithdrawIndex);
            const timestamp = header.timestamp;
            const order: RecentOrder = {
                timestamp,
                operation: "dao_withdraw",
                amount: ckbAmount,
                unit: "CKB",
            }
            recentOrders.push(order);
        }
    }
    recentOrders = recentOrders.sort((a, b) => Number(a.timestamp - b.timestamp));
    // Filter order mint and withdraw
    for await (const tx of signer.findTransactions({
        script: limitOrder,
    }, true, "desc")) {
        const header = await signer.client.getHeaderByNumber(tx.blockNumber);
        if (!header) {
            continue;
        }
        const inOutput = tx.cells.find(({ isInput }) => !isInput);
        if (inOutput) {
            const result = await signer.client.getTransaction(tx.txHash);
            if (!result) {
                continue;
            }
            const { transaction } = result;
            const orderIndex = transaction.outputs.findIndex(cell => scriptEq(cell.lock, limitOrder) && scriptEq(cell.type, udtType));
            if (orderIndex === -1) {
                continue;
            }
            const orderData = transaction.outputsData[orderIndex];
            const udtAmount = Uint128.unpack(orderData.slice(0, 2 + 16 * 2));
            const ckbAmount = unoccupiedCkb(transaction, orderIndex);
            const timestamp = header.timestamp;
            recentOrders.push({
                timestamp,
                operation: udtAmount > 0 ? "order_withdraw" : "order_deposit",
                amount: udtAmount > 0 ? udtAmount : ckbAmount,
                unit: udtAmount > 0 ? "iCKB" : "CKB",
            });
            recentOrders = recentOrders.sort((a, b) => Number(a.timestamp - b.timestamp));
            yield recentOrders.pop();
        }
    }
}

export async function getUserUdtCapacityBySigner(signer: ccc.Signer): Promise<bigint> {
    const udtType: ccc.ScriptLike = {
        codeHash: "0x50bd8d6680b8b9cf98b73f3c08faf8b2a21914311954118ad6609be6e78a1b95",
        args: "0xb73b6ab39d79390c6de90a09c96b290c331baf1798ed6f97aed02590929734e800000080",
        hashType: "data1",
    };
    let udtCapacity = BigInt(0);
    for await (const cell of signer.findCells({
        script: udtType
    }, true)) {
        udtCapacity += Uint128.unpack(cell.outputData.slice(0, 2 + 16 * 2));
    }
    return udtCapacity;
}
