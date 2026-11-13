import React, { useState } from 'react';

interface SaqoLogoProps {
  inverted?: boolean;
  showLogisticsSub?: boolean;
}

export const SaqoLogo: React.FC<SaqoLogoProps> = ({
  inverted = false,
}) => {
  const [imgFailed, setImgFailed] = useState(false);

  if (imgFailed) {
    return (
      <span
        className={`inline-flex items-center whitespace-nowrap shrink-0 select-none font-display font-extrabold tracking-widest text-xl leading-none ${
          inverted ? 'text-white' : 'text-black'
        }`}
      >
        SAQO LOGISTICS
      </span>
    );
  }

  return (
    <span className="inline-flex items-center whitespace-nowrap shrink-0 select-none">
      <img
        src="/assets/aistudio/SAQO_Logistics_Tech_Logo_7d775ebd.png"
        alt="SAQO Logistics"
        referrerPolicy="no-referrer"
        onError={() => setImgFailed(true)}
        className={`h-8 sm:h-9 w-auto object-contain ${inverted ? '' : 'invert'}`}
      />
    </span>
  );
};
