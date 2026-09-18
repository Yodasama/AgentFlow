import React, { useState, useRef, useEffect } from "react";
import { IconChevronDown, IconCheck } from "./icons";

export interface DrawerSelectOption {
  value: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
  badge?: string;
}

export interface DrawerSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: DrawerSelectOption[];
  placeholder?: string;
  customLabel?: string;
  className?: string;
  triggerStyle?: React.CSSProperties;
  menuStyle?: React.CSSProperties;
  disabled?: boolean;
  size?: "sm" | "md";
}

export function DrawerSelect({
  value,
  onChange,
  options,
  placeholder = "请选择…",
  customLabel,
  className = "",
  triggerStyle,
  menuStyle,
  disabled = false,
  size = "md",
}: DrawerSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((opt) => opt.value === value);

  // Close when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div
      ref={containerRef}
      className={`drawer-select-container ${size} ${className}`}
    >
      {/* Trigger Button */}
      <button
        type="button"
        disabled={disabled}
        className={`drawer-select-trigger ${size} ${isOpen ? "open" : ""}`}
        style={triggerStyle}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <div className="drawer-select-trigger-left">
          {selectedOption?.icon && (
            <span className="drawer-select-trigger-icon">
              {selectedOption.icon}
            </span>
          )}
          <span className="drawer-select-trigger-text">
            {customLabel || (selectedOption ? selectedOption.label : placeholder)}
          </span>
        </div>
        <span className={`drawer-select-arrow ${isOpen ? "open" : ""}`}>
          <IconChevronDown size={12} stroke="#787774" />
        </span>
      </button>

      {/* Drawer-Style Unfolding Dropdown Menu */}
      {isOpen && (
        <div
          className="drawer-select-dropdown"
          style={menuStyle}
          role="listbox"
        >
          <div className="drawer-select-options-list">
            {options.map((opt) => {
              const isSelected = opt.value === value;
              return (
                <div
                  key={opt.value}
                  role="option"
                  aria-selected={isSelected}
                  className={`drawer-select-option ${isSelected ? "selected" : ""}`}
                  onClick={() => {
                    onChange(opt.value);
                    setIsOpen(false);
                  }}
                >
                  <div className="drawer-select-option-main">
                    {opt.icon && (
                      <span className="drawer-select-option-icon">
                        {opt.icon}
                      </span>
                    )}
                    <div className="drawer-select-option-content">
                      <div className="drawer-select-option-label">
                        {opt.label}
                        {opt.badge && (
                          <span className="drawer-select-option-badge">
                            {opt.badge}
                          </span>
                        )}
                      </div>
                      {opt.description && (
                        <div className="drawer-select-option-desc">
                          {opt.description}
                        </div>
                      )}
                    </div>
                  </div>

                  {isSelected && (
                    <span className="drawer-select-option-check">
                      <IconCheck size={13} stroke="#111111" />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
