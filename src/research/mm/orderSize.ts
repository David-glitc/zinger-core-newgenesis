/** CTF order quantities use two decimal places and the book's share minimum. */
export function fullExitOrderSize(shares:number,minShares:number|undefined){
 if(!Number.isFinite(shares)||shares<=0||!Number.isFinite(minShares)||!(minShares!>0))return{ok:false,reason:'unknown_or_invalid_order_size'};
 if(shares+1e-9<minShares!)return{ok:false,reason:'below_minimum_order'};
 if(Math.abs(shares*100-Math.round(shares*100))>1e-7)return{ok:false,reason:'unencodable_full_position_size'};
 return{ok:true,reason:'order_size_valid'};
}
