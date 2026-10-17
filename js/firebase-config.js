// Firebase 設定
// ※ Firebase の Web 用 apiKey は「秘密鍵」ではなく、公開リポジトリに置いても問題ありません。
//   守るべきは Realtime Database の「ルール」です（README 参照 / database.rules.json）。
// 自分の Firebase プロジェクトを使う場合は、ここを書き換えてください。
export const firebaseConfig = {
  apiKey: "AIzaSyA2oSHXWACATwk5hRnmMl6c-gkqt7c_a9g",
  authDomain: "inkd-a22b4.firebaseapp.com",
  projectId: "inkd-a22b4",
  storageBucket: "inkd-a22b4.firebasestorage.app",
  messagingSenderId: "84119628832",
  appId: "1:84119628832:web:00f5cc393ec91c2bc76045",
  measurementId: "G-DLQHSYZLCJ"
  // Realtime Database が us-central1 以外（例: asia-southeast1）の場合は、次の行も追加してください:
  // databaseURL: "https://<your-project>-default-rtdb.asia-southeast1.firebasedatabase.app"
};
