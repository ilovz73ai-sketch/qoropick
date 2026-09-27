/// <reference types="vite/client" />
declare const __SEALER_COMMIT__: string;
interface ImportMetaEnv {
  /** 쉼표로 구분한 "돌아가기" 허용 접두어. 예: https://world.org/mini-app?app_id=app_xxx&,http://localhost:3000/ */
  readonly VITE_ALLOWED_RETURNS?: string;
  /** Check 페이지가 번들을 받을 앱 주소. 예: https://qoropick.example */
  readonly VITE_APP_URL?: string;
  /** World Chain RPC (Check 페이지가 결정 tx 를 직접 확인) */
  readonly VITE_RPC_URL?: string;
}
