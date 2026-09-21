import React from "react";
import { TokenUsageView } from "./TokenUsageView";
import { IconClose } from "./icons";

export interface TokenUsageModalProps {
  onClose: () => void;
  onOpenProviderModal?: () => void;
}

export function TokenUsageModal({ onClose, onOpenProviderModal }: TokenUsageModalProps) {
  return (
    <div className="token-modal-overlay" onClick={onClose}>
      <div className="token-modal-container" onClick={(e) => e.stopPropagation()}>
        {/* Close Button */}
        <button
          type="button"
          className="token-modal-close-btn"
          onClick={onClose}
          title="关闭"
        >
          <IconClose size={16} stroke="#3a3a3c" />
        </button>

        {/* Inner Content */}
        <div className="token-modal-content">
          <TokenUsageView onOpenProviderModal={onOpenProviderModal} />
        </div>
      </div>
    </div>
  );
}
