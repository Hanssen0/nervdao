"use client";

import { ccc } from "@ckb-ccc/connector-react";
import { NotificationProvider } from "@/context/NotificationProvider";
import Notification from "@/app/components/Notification";
import { CSSProperties } from "react";
import React from "react";

export  function  LayoutProvider({ children }: { children: React.ReactNode }) {
  const defaultClient = React.useMemo(() => {
    return process.env.NEXT_PUBLIC_IS_MAINNET === "true"
      ? new ccc.ClientPublicMainnet()
      : new ccc.ClientPublicTestnet();
  }, []);
  
  return (
    <ccc.Provider

      connectorProps={{
        style: {
          "--background": "#232323",
          "--divider": "rgba(255, 255, 255, 0.1)",
          "--btn-primary": "#2D2F2F",
          "--btn-primary-hover": "#515151",
          "--btn-secondary": "#2D2F2F",
          "--btn-secondary-hover": "#515151",
          "--icon-primary": "#FFFFFF",
          "--icon-secondary": "rgba(255, 255, 255, 0.6)",
          color: "#ffffff",
          "--tip-color": "#666",
        } as CSSProperties,
      }}
      defaultClient={defaultClient}
      clientOptions={[
        {
          name: "CKB Testnet",
          client: new ccc.ClientPublicTestnet(),
        },
        {
          name: "CKB Mainnet",
          client: new ccc.ClientPublicMainnet(),
        },
      ]}
    >
       
        <NotificationProvider>
          {children}
          <Notification />
        </NotificationProvider>
     
    </ccc.Provider>
  );
}
