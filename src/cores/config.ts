import { ccc } from "@ckb-ccc/core";
import { Cell, Transaction, helpers } from "@ckb-lumos/lumos";
import { ChainConfig, chainConfigFrom, I8Script, lockExpanderFrom, i8ScriptPadding } from "@ickb/lumos-utils";
import { getIckbScriptConfigs } from "@ickb/v1-core";
import type { QueryClient } from "@tanstack/react-query"

export interface WalletConfig extends ChainConfig {
    address: ccc.Hex;
    accountLock: I8Script;
    expander: (c: Cell) => I8Script | undefined;
    addPlaceholders: (tx: helpers.TransactionSkeletonType) => helpers.TransactionSkeletonType;
    signer: (tx: helpers.TransactionSkeletonType) => Promise<Transaction>;
    queryClient: QueryClient;
}

const WalletConfig: WalletConfig | undefined = undefined;

export async function setupWalletConfig(signer: ccc.Signer) {
    const chain = signer.client.addressPrefix === "ckb" ? "mainnet" : "testnet";
    const chainConfig = await chainConfigFrom(chain, undefined, true, getIckbScriptConfigs);
    const addresses = await signer.getAddressObjs();
    let signerAddress = addresses[0];
    for (const address of addresses) {
        const balance = await signer.client.getBalance([address.script]);
        if (balance > 0) {
            signerAddress = address;
            break;
        }
    }
    const signerLock = I8Script.from({
        ...i8ScriptPadding,
        ...signerAddress.script,

    });
    return {
        ...chainConfig,
        address: signerAddress.toString(),
        accountLock: signerLock,
        expander: lockExpanderFrom(signerLock),
        addPlaceholders: (tx: helpers.TransactionSkeletonType) => tx,
        signer: async (tx: helpers.TransactionSkeletonType) => {
            const cccTx = ccc.Transaction.fromLumosSkeleton(tx);
            return await signer.signTransaction(cccTx);
        }
    }
}

export function getWalletConfig(): WalletConfig {
    if (!WalletConfig) {

        throw new Error("please call `setupWalletConfig` at first");
    }
    return WalletConfig;
}
