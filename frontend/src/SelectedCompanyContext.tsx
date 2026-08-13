import { createContext, useContext, useState, type ReactNode } from 'react';

interface SelectedCompanyContextValue {
  /** The company the user is currently working with — carried across Connections,
   *  Device Pairing, Tally Direct, and Extractions so it's never picked twice. */
  selectedCompany: string | null;
  selectCompany: (company: string | null) => void;
}

const STORAGE_KEY = 'tally-e2e-selected-company';

const SelectedCompanyContext = createContext<SelectedCompanyContextValue | null>(null);

export function SelectedCompanyProvider({ children }: { children: ReactNode }) {
  const [selectedCompany, setSelectedCompany] = useState<string | null>(() =>
    sessionStorage.getItem(STORAGE_KEY),
  );

  const selectCompany = (company: string | null) => {
    if (company) sessionStorage.setItem(STORAGE_KEY, company);
    else sessionStorage.removeItem(STORAGE_KEY);
    setSelectedCompany(company);
  };

  return (
    <SelectedCompanyContext.Provider value={{ selectedCompany, selectCompany }}>
      {children}
    </SelectedCompanyContext.Provider>
  );
}

export function useSelectedCompany(): SelectedCompanyContextValue {
  const ctx = useContext(SelectedCompanyContext);
  if (!ctx) throw new Error('useSelectedCompany must be used within SelectedCompanyProvider');
  return ctx;
}
